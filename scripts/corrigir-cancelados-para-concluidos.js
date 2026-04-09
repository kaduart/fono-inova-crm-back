// ✅ Corrige appointments "canceled" → "completed" baseado nos dados reais
// USO: DRY_RUN=false node corrigir-cancelados-para-concluidos.js
//
// Este script corrige especificamente os appointments que estão como 'canceled'
// mas têm Session completed ou Payment pago

import mongoose from 'mongoose';
import dotenv from 'dotenv';

import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';

dotenv.config();

const DRY_RUN = process.env.DRY_RUN !== 'false';
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

async function corrigirCancelados() {
    console.log('========================================');
    console.log('✅ CORREÇÃO: Cancelados → Concluídos');
    console.log(`📋 MODO: ${DRY_RUN ? 'DRY RUN (visualização)' : 'EXECUÇÃO REAL'}`);
    console.log('========================================\n');

    await mongoose.connect(MONGO_URI);
    console.log('✅ Conectado ao MongoDB\n');

    const stats = {
        analisados: 0,
        corrigidos: 0,
        erros: []
    };

    // ============================================
    // 1. BUSCAR APPOINTMENTS CANCELADOS
    // ============================================
    console.log('🔍 Buscando appointments cancelados...\n');

    const cancelados = await Appointment.find({
        operationalStatus: { $in: ['canceled', 'cancelado'] },
        isDeleted: { $ne: true }
    }).sort({ date: -1 });

    console.log(`📦 ${cancelados.length} appointments cancelados encontrados\n`);

    // ============================================
    // 2. VERIFICAR E CORRIGIR
    // ============================================
    for (const apt of cancelados) {
        try {
            stats.analisados++;
            const aptId = apt._id.toString();
            
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

            const temSessionCompleted = session && ['completed', 'finished', 'done'].includes(session.status);
            const temPaymentPago = payment && ['paid', 'completed'].includes(payment.status);

            // Se deve ser concluído
            if (temSessionCompleted || temPaymentPago) {
                const motivo = [];
                if (temSessionCompleted) motivo.push(`Session: ${session.status}`);
                if (temPaymentPago) motivo.push(`Payment: ${payment.status}`);

                console.log(`📝 Corrigindo: ${aptId}`);
                console.log(`   Paciente: ${apt.patient || 'N/D'}`);
                console.log(`   Data: ${apt.date?.toISOString().split('T')[0]} ${apt.time || ''}`);
                console.log(`   ${apt.operationalStatus} → completed`);
                console.log(`   Motivo: ${motivo.join(' + ')}`);

                if (!DRY_RUN) {
                    // Atualizar
                    apt.operationalStatus = 'completed';
                    
                    // Adicionar histórico
                    apt.history = apt.history || [];
                    apt.history.push({
                        action: 'status_correction_canceled_to_completed',
                        previousStatus: 'canceled',
                        newStatus: 'completed',
                        reason: `Baseado em dados reais: ${motivo.join(', ')}`,
                        sessionId: session?._id,
                        paymentId: payment?._id,
                        timestamp: new Date()
                    });

                    await apt.save({ validateBeforeSave: false });
                    console.log('   ✅ Corrigido!\n');
                } else {
                    console.log('   [DRY RUN - não salvo]\n');
                }

                stats.corrigidos++;
            }

        } catch (error) {
            console.error(`❌ Erro no appointment ${apt._id}:`, error.message);
            stats.erros.push({ appointmentId: apt._id, error: error.message });
        }
    }

    // ============================================
    // 3. RELATÓRIO
    // ============================================
    console.log('========================================');
    console.log('📊 RELATÓRIO DE CORREÇÃO');
    console.log('========================================');
    console.log(`Total analisados: ${stats.analisados}`);
    console.log(`Corrigidos: ${stats.corrigidos}`);
    console.log(`Erros: ${stats.erros.length}`);

    if (stats.erros.length > 0) {
        console.log('\n❌ Erros encontrados:');
        stats.erros.forEach(e => console.log(`   - ${e.appointmentId}: ${e.error}`));
    }

    if (DRY_RUN) {
        console.log('\n⚠️  DRY RUN - Nenhuma alteração foi salva!');
        console.log('   Para executar de verdade:');
        console.log('   DRY_RUN=false node corrigir-cancelados-para-concluidos.js');
    } else {
        console.log('\n💾 Correções salvas no banco!');
    }

    await mongoose.disconnect();
    console.log('\n👋 Done!');
    process.exit(0);
}

corrigirCancelados().catch(err => {
    console.error('💥 Erro:', err);
    process.exit(1);
});
