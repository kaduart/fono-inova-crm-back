// 🔍 INVESTIGAÇÃO: Será que o atendimento REALMENTE aconteceu?
// Analisa appointments "canceled" que têm Session "completed"
//
// Critérios para confirmar que foi atendimento real:
// 1. Session tem campos preenchidos (evolution, observations, etc)
// 2. Data da session é próxima ou igual à data do appointment
// 3. Histórico do appointment mostra que foi finalizado antes de ser cancelado
// 4. Pagamento existe e está pago

import mongoose from 'mongoose';
import dotenv from 'dotenv';

import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

async function investigar() {
    console.log('========================================');
    console.log('🔍 INVESTIGAÇÃO: Cancelados com Session');
    console.log('Será que o atendimento REALMENTE aconteceu?');
    console.log('========================================\n');

    await mongoose.connect(MONGO_URI);
    console.log('✅ Conectado ao MongoDB\n');

    // Buscar appointments cancelados que têm session
    const appointments = await Appointment.find({
        operationalStatus: { $in: ['canceled', 'cancelado'] },
        isDeleted: { $ne: true }
    }).sort({ date: -1 });

    console.log(`📦 ${appointments.length} appointments cancelados encontrados\n`);

    const categorias = {
        atendimentoReal: [],      // ✅ Session preenchida + dados = atendimento aconteceu
        suspeitos: [],            // ⚠️  Session vazia ou inconsistente
        provavelErro: [],         // ❌ Session criada mas cancelada antes do atendimento
        semSession: []            // 📭 Sem session (cancelado antes)
    };

    for (const apt of appointments) {
        const aptId = apt._id.toString();
        
        // Buscar Session completa
        const session = await Session.findOne({
            $or: [
                { appointmentId: apt._id },
                { _id: apt.session }
            ],
            isDeleted: { $ne: true }
        });

        // Buscar Payment
        const payment = await Payment.findOne({
            $or: [
                { appointmentId: apt._id },
                { _id: apt.payment }
            ]
        });

        // Se não tem session, é cancelamento legítimo antes do atendimento
        if (!session) {
            categorias.semSession.push({
                aptId,
                patient: apt.patient?.toString(),
                date: apt.date,
                motivo: 'Sem session - cancelado antes do atendimento'
            });
            continue;
        }

        // Analisar se session tem conteúdo (evolution, observations)
        const temConteudo = session.evolution || 
                           session.observations || 
                           session.procedures?.length > 0 ||
                           session.notes;

        // Analisar histórico do appointment
        const foiFinalizadoAntes = apt.history?.some(h => 
            h.action?.includes('complete') || 
            h.action?.includes('finish') ||
            h.newStatus === 'completed'
        );

        const foiCanceladoDepois = apt.history?.some(h => 
            h.action?.includes('cancel') || 
            h.newStatus === 'canceled'
        );

        // Verificar datas
        const dataApt = new Date(apt.date);
        const dataSession = session.date ? new Date(session.date) : null;
        const mesmaData = dataSession && 
                         dataApt.toISOString().split('T')[0] === dataSession.toISOString().split('T')[0];

        // Verificar se tem pagamento pago
        const temPagamentoPago = payment && ['paid', 'completed'].includes(payment.status);

        // CRITÉRIOS PARA CONFIRMAR ATENDIMENTO REAL
        const scoreAtendimentoReal = [
            temConteudo ? 3 : 0,           // Session tem conteúdo = peso 3
            temPagamentoPago ? 2 : 0,       // Pagamento pago = peso 2
            foiFinalizadoAntes ? 2 : 0,     // Histórico mostra finalização = peso 2
            mesmaData ? 1 : 0,              // Mesma data = peso 1
            session.status === 'completed' ? 1 : 0 // Status completed = peso 1
        ].reduce((a, b) => a + b, 0);

        const analise = {
            aptId,
            patient: apt.patient?.toString(),
            patientName: apt.patientInfo?.fullName || 'N/D',
            date: apt.date?.toISOString().split('T')[0],
            time: apt.time,
            sessionId: session._id?.toString(),
            sessionStatus: session.status,
            sessionDate: session.date?.toISOString().split('T')[0],
            temConteudo: !!temConteudo,
            conteudoPreview: temConteudo ? 
                (session.evolution?.substring(0, 50) || session.observations?.substring(0, 50) || 'Tem dados') 
                : 'Vazia',
            temPagamentoPago,
            paymentStatus: payment?.status || 'N/A',
            foiFinalizadoAntes,
            foiCanceladoDepois,
            mesmaData,
            scoreAtendimentoReal,
            historyActions: apt.history?.map(h => h.action || h.newStatus).slice(-3) || []
        };

        // Classificar
        if (scoreAtendimentoReal >= 5) {
            // ✅ Score alto = atendimento provavelmente aconteceu
            categorias.atendimentoReal.push(analise);
        } else if (scoreAtendimentoReal >= 2) {
            // ⚠️ Score médio = suspeito, precisa revisar
            categorias.suspeitos.push(analise);
        } else {
            // ❌ Score baixo = provavelmente erro/cancelamento legítimo
            categorias.provavelErro.push(analise);
        }
    }

    // ============================================
    // RELATÓRIO DETALHADO
    // ============================================
    
    console.log('\n========================================');
    console.log('📊 RELATÓRIO DE INVESTIGAÇÃO');
    console.log('========================================');
    
    console.log(`\n✅ ATENDIMENTO REAL (score ≥ 5): ${categorias.atendimentoReal.length}`);
    console.log('   → Session tem conteúdo + pagamento/histórico');
    console.log('   → RECOMENDAÇÃO: Mudar para completed');
    
    if (categorias.atendimentoReal.length > 0) {
        console.log('\n   Lista:');
        categorias.atendimentoReal.forEach(a => {
            console.log(`   - ${a.aptId} (${a.date} ${a.time})`);
            console.log(`     Score: ${a.scoreAtendimentoReal}/9 | Conteúdo: ${a.temConteudo ? 'SIM' : 'NÃO'} | Pago: ${a.temPagamentoPago ? 'SIM' : 'NÃO'}`);
        });
    }

    console.log(`\n⚠️  SUSPEITOS (score 2-4): ${categorias.suspeitos.length}`);
    console.log('   → Alguns indícios, mas não conclusivo');
    console.log('   → RECOMENDAÇÃO: Revisar manualmente');
    
    if (categorias.suspeitos.length > 0) {
        console.log('\n   Lista:');
        categorias.suspeitos.forEach(a => {
            console.log(`   - ${a.aptId} (${a.date} ${a.time})`);
            console.log(`     Score: ${a.scoreAtendimentoReal}/9 | Conteúdo: ${a.temConteudo ? 'SIM' : 'NÃO'} | Pago: ${a.temPagamentoPago ? 'SIM' : 'NÃO'}`);
            console.log(`     Histórico: ${a.historyActions.join(' → ')}`);
        });
    }

    console.log(`\n❌ PROVÁVEL ERRO/CANCELADO (score < 2): ${categorias.provavelErro.length}`);
    console.log('   → Session existe mas sem conteúdo/evidências');
    console.log('   → RECOMENDAÇÃO: Manter como canceled OU investigar mais');

    console.log(`\n📭 SEM SESSION: ${categorias.semSession.length}`);
    console.log('   → Cancelado antes do atendimento (correto)');

    // Salvar relatório completo em JSON
    const fs = await import('fs');
    const relatorio = {
        data: new Date().toISOString(),
        resumo: {
            total: appointments.length,
            atendimentoReal: categorias.atendimentoReal.length,
            suspeitos: categorias.suspeitos.length,
            provavelErro: categorias.provavelErro.length,
            semSession: categorias.semSession.length
        },
        detalhes: categorias
    };
    
    const arquivoSaida = `investigacao-cancelados-${Date.now()}.json`;
    fs.writeFileSync(arquivoSaida, JSON.stringify(relatorio, null, 2));
    console.log(`\n💾 Relatório completo salvo em: ${arquivoSaida}`);

    await mongoose.disconnect();
    console.log('\n👋 Done!');
    process.exit(0);
}

investigar().catch(err => {
    console.error('💥 Erro:', err);
    process.exit(1);
});
