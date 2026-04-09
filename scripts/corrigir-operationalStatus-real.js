// 🩹 Correção de operationalStatus baseado em Session e Payment reais
// USO: DRY_RUN=false node corrigir-operationalStatus-real.js
//
// Este script:
// 1. Busca appointments com operationalStatus incorreto
// 2. Verifica Session e Payment relacionados
// 3. Atualiza operationalStatus baseado nos dados reais

import mongoose from 'mongoose';
import dotenv from 'dotenv';

// Models
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';

dotenv.config();

const DRY_RUN = process.env.DRY_RUN !== 'false';
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

// Status que indicam que o agendamento foi processado
const COMPLETED_STATUSES = ['completed', 'concluído', 'pago', 'paid'];
const CANCELED_STATUSES = ['canceled', 'cancelado'];

async function corrigirOperationalStatus() {
    console.log('========================================');
    console.log('🩹 CORREÇÃO DE OPERATIONAL STATUS');
    console.log(`📋 MODO: ${DRY_RUN ? 'DRY RUN (visualização)' : 'EXECUÇÃO REAL'}`);
    console.log('========================================\n');

    await mongoose.connect(MONGO_URI);
    console.log('✅ Conectado ao MongoDB\n');

    const stats = {
        analisados: 0,
        corrigidos: 0,
        cancelados: 0,
        concluidos: 0,
        canceladosParaConcluidos: 0,  // 🔥 Casos críticos
        semAlteracao: 0,
        erros: []
    };

    // ============================================
    // 1. BUSCAR APPOINTMENTS QUE PRECISAM DE CORREÇÃO
    // ============================================
    console.log('🔍 Buscando appointments para análise...\n');

    const appointments = await Appointment.find({
        $or: [
            // Status genéricos que não refletem a realidade
            { operationalStatus: { $exists: false } },
            { operationalStatus: null },
            { operationalStatus: '' },
            { operationalStatus: 'scheduled' }, // Pode estar completed/canceled na verdade
            { operationalStatus: 'pending' },   // Pode estar completed/canceled na verdade
            { operationalStatus: 'confirmed' }, // Pode estar completed/canceled na verdade
            { operationalStatus: 'canceled' }   // 🔥 PODE estar completed na verdade (session/payment)
        ],
        isDeleted: { $ne: true }
    }).sort({ date: -1 }).limit(5000);

    console.log(`📦 ${appointments.length} appointments encontrados para análise\n`);

    // ============================================
    // 2. PROCESSAR CADA APPOINTMENT
    // ============================================
    for (const apt of appointments) {
        try {
            stats.analisados++;
            
            const aptId = apt._id.toString();
            const currentStatus = apt.operationalStatus || 'N/D';
            
            // Buscar Session relacionada
            const session = await Session.findOne({
                $or: [
                    { appointmentId: apt._id },
                    { _id: apt.session }
                ],
                isDeleted: { $ne: true }
            });

            // Buscar Payment relacionado
            const payment = await Payment.findOne({
                $or: [
                    { appointmentId: apt._id },
                    { _id: apt.payment }
                ]
            });

            // Determinar status correto
            let novoStatus = null;
            let motivo = '';

            // ============ REGRAS DE PRIORIDADE (Session/Payment = fonte de verdade) ============
            
            // REGRA 1: Session completed = atendimento aconteceu → SEMPRE completed
            // 💥 Isso sobrescreve QUALQUER status, inclusive 'canceled'
            if (session && ['completed', 'finished', 'done'].includes(session.status)) {
                novoStatus = 'completed';
                motivo = 'Session está completed (fonte de verdade)';
            }
            // REGRA 2: Payment pago = atendimento foi pago → SEMPRE completed  
            // 💥 Isso também sobrescreve 'canceled' (atendimento aconteceu)
            else if (payment && ['paid', 'completed'].includes(payment.status)) {
                novoStatus = 'completed';
                motivo = 'Payment está pago (fonte de verdade)';
            }
            // REGRA 3: Session cancelada → canceled (só se não tiver session completed/pago)
            else if (session && (session.status === 'canceled' || session.isCanceled)) {
                novoStatus = 'canceled';
                motivo = 'Session está cancelada';
            }
            // REGRA 4: Payment cancelado → canceled (só se não tiver session/pago)
            else if (payment && payment.status === 'canceled') {
                novoStatus = 'canceled';
                motivo = 'Payment está cancelado';
            }
            // REGRA 5: Se não tem nem Session nem Payment → verificar se é missed
            else if (!session && !payment) {
                const aptDate = new Date(apt.date);
                const hoje = new Date();
                
                if (aptDate < hoje && currentStatus !== 'missed') {
                    novoStatus = 'missed';
                    motivo = 'Data passou sem sessão/pagamento';
                } else {
                    stats.semAlteracao++;
                    continue; // Pular se não precisa mudar
                }
            }

            // Se determinou um novo status diferente do atual
            if (novoStatus && novoStatus !== currentStatus) {
                // 🔥 Destacar quando corrige de 'canceled' para 'completed'
                const isCriticalFix = currentStatus === 'canceled' && novoStatus === 'completed';
                const icon = isCriticalFix ? '🔥🔥🔥' : '📝';
                const label = isCriticalFix ? 'CORREÇÃO CRÍTICA' : 'Correção';
                
                console.log(`\n${icon} ${label}: ${aptId}`);
                console.log(`   Paciente: ${apt.patient || 'N/D'}`);
                console.log(`   Data: ${apt.date?.toISOString().split('T')[0]} ${apt.time || ''}`);
                console.log(`   Status atual: ${currentStatus} → Novo: ${novoStatus}`);
                if (isCriticalFix) {
                    console.log(`   ⚠️  ATENÇÃO: Appointment estava como CANCELADO mas atendimento foi REALIZADO!`);
                }
                console.log(`   Motivo: ${motivo}`);
                console.log(`   Session: ${session ? session._id : 'N/A'} (${session?.status || 'N/A'})`);
                console.log(`   Payment: ${payment ? payment._id : 'N/A'} (${payment?.status || 'N/A'})`);

                if (!DRY_RUN) {
                    // Atualizar appointment
                    apt.operationalStatus = novoStatus;
                    
                    // Adicionar ao histórico
                    apt.history = apt.history || [];
                    apt.history.push({
                        action: 'status_correction',
                        previousStatus: currentStatus,
                        newStatus: novoStatus,
                        reason: motivo,
                        sessionId: session?._id,
                        paymentId: payment?._id,
                        timestamp: new Date()
                    });

                    await apt.save({ validateBeforeSave: false });
                    console.log('   ✅ Corrigido!');
                } else {
                    console.log('   [DRY RUN - não salvo]');
                }

                stats.corrigidos++;
                if (novoStatus === 'canceled') stats.cancelados++;
                if (novoStatus === 'completed') {
                    stats.concluidos++;
                    // 🔥 Contar casos críticos: canceled → completed
                    if (currentStatus === 'canceled') {
                        stats.canceladosParaConcluidos++;
                    }
                }
            } else {
                stats.semAlteracao++;
            }

        } catch (error) {
            console.error(`❌ Erro no appointment ${apt._id}:`, error.message);
            stats.erros.push({ appointmentId: apt._id, error: error.message });
        }
    }

    // ============================================
    // 3. RELATÓRIO FINAL
    // ============================================
    console.log('\n========================================');
    console.log('📊 RELATÓRIO DE CORREÇÃO');
    console.log('========================================');
    console.log(`Total analisados: ${stats.analisados}`);
    console.log(`Corrigidos: ${stats.corrigidos}`);
    console.log(`  → Concluídos: ${stats.concluidos}`);
    if (stats.canceladosParaConcluidos > 0) {
        console.log(`     🔥 CASOS CRÍTICOS (canceled → completed): ${stats.canceladosParaConcluidos}`);
    }
    console.log(`  → Cancelados: ${stats.cancelados}`);
    console.log(`Sem alteração necessária: ${stats.semAlteracao}`);
    console.log(`Erros: ${stats.erros.length}`);

    if (stats.erros.length > 0) {
        console.log('\n❌ Erros encontrados:');
        stats.erros.forEach(e => console.log(`   - ${e.appointmentId}: ${e.error}`));
    }

    if (DRY_RUN) {
        console.log('\n⚠️  DRY RUN - Nenhuma alteração foi salva!');
        console.log('   Para executar de verdade:');
        console.log('   DRY_RUN=false node corrigir-operationalStatus-real.js');
    } else {
        console.log('\n💾 Correções salvas no banco!');
    }

    await mongoose.disconnect();
    console.log('\n👋 Done!');
    process.exit(0);
}

corrigirOperationalStatus().catch(err => {
    console.error('💥 Erro fatal:', err);
    process.exit(1);
});
