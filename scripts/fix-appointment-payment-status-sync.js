#!/usr/bin/env node
/**
 * 🧹 SINCRONIZAÇÃO appointment.paymentStatus → Payment.status
 * 
 * PROBLEMA: Vários services rotas marcavam appointment.paymentStatus = 'paid'
 * automaticamente ao completar sessão, sem confirmação de pagamento.
 * Isso gerou inconsistências onde o appointment diz "paid" mas Payment diz "pending".
 * 
 * ESTE SCRIPT: Reseta para 'pending' todos os appointments que:
 *   - Têm paymentStatus = 'paid' (ou 'package_paid')
 *   - MAS não possuem Payment associado com status = 'paid'
 * 
 * Regra: Payment é fonte de verdade. Appointment não decide dinheiro.
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import Appointment from '../models/Appointment.js';
import Payment from '../models/Payment.js';

async function run() {
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/fono_inova_prod';
    console.log(`[SYNC] Conectando em: ${uri.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')}`);
    await mongoose.connect(uri);
    console.log('[SYNC] ✅ Conectado');

    // Busca todos os appointments que dizem estar pagos
    const paidLikeStatuses = ['paid', 'package_paid'];
    const suspiciousAppointments = await Appointment.find({
        paymentStatus: { $in: paidLikeStatuses }
    }).select('_id patient paymentStatus visualFlag').lean();

    console.log(`[SYNC] Appointments marcados como pagos: ${suspiciousAppointments.length}`);

    let corrected = 0;
    let alreadyOk = 0;
    let errors = 0;
    const details = [];

    for (const appt of suspiciousAppointments) {
        try {
            // Busca Payment associado (tanto por appointment quanto por appointmentId)
            const payment = await Payment.findOne({
                $or: [
                    { appointment: appt._id },
                    { appointmentId: appt._id.toString() }
                ]
            }).select('status amount').lean();

            const hasPaidPayment = payment && payment.status === 'paid';

            if (!hasPaidPayment) {
                // ❌ INCONSISTÊNCIA: appointment diz pago, mas Payment não confirma
                const oldStatus = appt.paymentStatus;
                await Appointment.updateOne(
                    { _id: appt._id },
                    { $set: { paymentStatus: 'pending', visualFlag: 'pending' } }
                );
                corrected++;
                details.push({
                    appointmentId: appt._id.toString(),
                    patient: appt.patient?.toString(),
                    oldStatus,
                    paymentStatus: payment?.status || 'NO_PAYMENT',
                    paymentAmount: payment?.amount || 0,
                    action: 'CORRECTED_TO_PENDING'
                });
            } else {
                alreadyOk++;
            }
        } catch (err) {
            errors++;
            details.push({
                appointmentId: appt._id.toString(),
                error: err.message
            });
        }
    }

    console.log('\n📊 RESUMO:');
    console.log(`   ✅ Já consistentes (Payment=paid): ${alreadyOk}`);
    console.log(`   🔧 Corrigidos para pending:        ${corrected}`);
    console.log(`   ❌ Erros:                           ${errors}`);

    if (corrected > 0) {
        console.log('\n🔍 DETALHES DAS CORREÇÕES:');
        details.filter(d => d.action === 'CORRECTED_TO_PENDING').forEach(d => {
            console.log(`   - ${d.appointmentId} | antigo=${d.oldStatus} | payment=${d.paymentStatus} | amount=${d.paymentAmount}`);
        });
    }

    await mongoose.disconnect();
    console.log('\n[SYNC] ✅ Finalizado');
    process.exit(0);
}

run().catch(err => {
    console.error('[SYNC] ❌ Erro fatal:', err);
    process.exit(1);
});
