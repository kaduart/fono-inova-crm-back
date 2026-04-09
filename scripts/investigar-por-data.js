// 🔍 INVESTIGAÇÃO POR DATA ESPECÍFICA
// Analisa appointments de uma data específica com histórico completo
//
// Uso: node investigar-por-data.js <data>
// Exemplo: node investigar-por-data.js 2023-04-08

import mongoose from 'mongoose';
import dotenv from 'dotenv';

import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

// Pegar data do argumento ou usar padrão
const DATA_ALVO = process.argv[2] || '2023-04-08';

async function investigarPorData() {
    console.log('========================================');
    console.log(`🔍 INVESTIGAÇÃO: Data ${DATA_ALVO}`);
    console.log('========================================\n');

    await mongoose.connect(MONGO_URI);
    console.log('✅ Conectado ao MongoDB\n');

    // Converter data para comparar (formato YYYY-MM-DD)
    const dataInicio = new Date(DATA_ALVO + 'T00:00:00.000Z');
    const dataFim = new Date(DATA_ALVO + 'T23:59:59.999Z');

    // Buscar appointments da data
    const appointments = await Appointment.find({
        date: {
            $gte: dataInicio,
            $lte: dataFim
        },
        isDeleted: { $ne: true }
    }).sort({ time: 1 });

    console.log(`📅 ${appointments.length} appointments encontrados em ${DATA_ALVO}\n`);

    for (const apt of appointments) {
        const aptId = apt._id.toString();
        
        console.log('─'.repeat(60));
        console.log(`📋 Appointment: ${aptId}`);
        console.log(`   Paciente: ${apt.patient?.toString() || 'N/D'}`);
        console.log(`   Data/Hora: ${apt.date?.toISOString().split('T')[0]} ${apt.time || 'N/D'}`);
        console.log(`   Status ATUAL: ${apt.operationalStatus || 'N/D'}`);
        console.log(`   Clinical: ${apt.clinicalStatus || 'N/D'}`);
        
        // Buscar Session
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

        console.log(`   Session: ${session ? session._id : 'N/A'} (${session?.status || 'N/A'})`);
        console.log(`   Payment: ${payment ? payment._id : 'N/A'} (${payment?.status || 'N/A'})`);

        // Mostrar histórico completo
        console.log('\n   📜 HISTÓRICO:');
        if (apt.history && apt.history.length > 0) {
            apt.history.forEach((h, i) => {
                const data = h.timestamp ? new Date(h.timestamp).toLocaleString('pt-BR') : 'sem data';
                const acao = h.action || 'status_change';
                const de = h.previousStatus || h.oldStatus || '-';
                const para = h.newStatus || '-';
                const motivo = h.reason || h.context || '';
                
                console.log(`      ${i + 1}. [${data}] ${acao}`);
                console.log(`         ${de} → ${para} ${motivo ? '| ' + motivo : ''}`);
            });
        } else {
            console.log('      (sem histórico)');
        }

        // Análise de consistência
        console.log('\n   🔍 ANÁLISE:');
        const inconsistencias = [];

        // Appointment canceled mas session completed
        if (apt.operationalStatus === 'canceled' && session?.status === 'completed') {
            inconsistencias.push('⚠️  Appointment CANCELADO mas session COMPLETED');
            
            // Ver se tem histórico de finalização antes do cancelamento
            const finalizacao = apt.history?.find(h => 
                h.newStatus === 'completed' || h.action?.includes('complete')
            );
            const cancelamento = apt.history?.find(h => 
                h.newStatus === 'canceled' || h.action?.includes('cancel')
            );
            
            if (finalizacao && cancelamento) {
                const dataFinal = new Date(finalizacao.timestamp);
                const dataCancel = new Date(cancelamento.timestamp);
                
                if (dataFinal < dataCancel) {
                    inconsistencias.push('   → Foi finalizado ANTES de ser cancelado');
                    inconsistencias.push('   → PROVÁVEL: Atendimento aconteceu, depois foi cancelado (erro?)');
                } else {
                    inconsistencias.push('   → Foi cancelado ANTES de ser finalizado');
                    inconsistencias.push('   → PROVÁVEL: Cancelamento legítimo, session não atualizou');
                }
            }
        }

        // Appointment completed mas payment pending
        if (apt.operationalStatus === 'completed' && payment?.status === 'pending') {
            inconsistencias.push('⚠️  Appointment COMPLETED mas payment PENDING');
        }

        // Appointment scheduled mas data passou
        const hoje = new Date();
        const dataApt = new Date(apt.date);
        if (apt.operationalStatus === 'scheduled' && dataApt < hoje) {
            inconsistencias.push('⚠️  Appointment SCHEDULED mas data já passou');
        }

        if (inconsistencias.length === 0) {
            console.log('      ✅ Consistente');
        } else {
            inconsistencias.forEach(msg => console.log(`      ${msg}`));
        }

        console.log('');
    }

    await mongoose.disconnect();
    console.log('👋 Done!');
    process.exit(0);
}

investigarPorData().catch(err => {
    console.error('💥 Erro:', err);
    process.exit(1);
});
