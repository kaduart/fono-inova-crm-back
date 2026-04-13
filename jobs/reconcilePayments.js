// jobs/reconcilePayments.js
/**
 * JOB DE RECONCILIAÇÃO PAYMENT ↔ APPOINTMENT
 * 
 * Objetivo: Corrigir inconsistências automaticamente
 * Uso: node jobs/reconcilePayments.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Payment from '../models/Payment.js';
import Appointment from '../models/Appointment.js';

dotenv.config();

async function runReconciliation() {
    console.log("🔄 RECONCILIATION START");
    console.log("============================");

    let fixed = 0;
    let skipped = 0;
    let errors = 0;

    try {
        // 1. Pega payments concluídos (paid/processed)
        const payments = await Payment.find({
            status: { $in: ['paid', 'processed'] }
        }).lean();

        console.log(`📊 Encontrados ${payments.length} payments para verificar`);

        for (const payment of payments) {
            try {
                // Só processa se tiver appointment vinculado
                if (!payment.appointmentId && !payment.appointment) {
                    skipped++;
                    continue;
                }

                const appointmentId = payment.appointmentId || payment.appointment;
                const appointment = await Appointment.findById(appointmentId);

                if (!appointment) {
                    console.log(`⚠️ Appointment não encontrado: ${appointmentId}`);
                    skipped++;
                    continue;
                }

                // Verifica se precisa de correção
                const needsFix =
                    appointment.financialStatus !== 'paid' ||
                    String(appointment.paymentId || '') !== String(payment._id) ||
                    !appointment.payment;

                if (needsFix) {
                    await Appointment.findByIdAndUpdate(appointmentId, {
                        $set: {
                            financialStatus: 'paid',
                            paymentStatus: 'paid',
                            paymentId: payment._id.toString(),
                            payment: payment._id,
                            paidAt: appointment.paidAt || payment.paidAt || new Date(),
                            lastPaymentAt: new Date()
                        },
                        $push: {
                            history: {
                                action: 'payment_reconciled',
                                timestamp: new Date(),
                                paymentId: payment._id.toString(),
                                context: `Correção automática de reconciliação`
                            }
                        }
                    });

                    fixed++;
                    console.log(`✅ FIXED: Appointment ${appointmentId} syncado com Payment ${payment._id}`);
                } else {
                    skipped++;
                }
            } catch (itemError) {
                errors++;
                console.error(`❌ Erro no payment ${payment._id}:`, itemError.message);
            }
        }

        console.log("============================");
        console.log("🏁 RECONCILIATION DONE");
        console.log(`   ✅ Corrigidos: ${fixed}`);
        console.log(`   ⏭️  Ignorados: ${skipped}`);
        console.log(`   ❌ Erros: ${errors}`);

    } catch (error) {
        console.error("🚨 Erro fatal na reconciliação:", error.message);
        process.exit(1);
    }

    await mongoose.disconnect();
    console.log("🔌 Desconectado do MongoDB");
    process.exit(0);
}

// Conecta e executa
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/crm')
    .then(() => {
        console.log("✅ MongoDB conectado");
        return runReconciliation();
    })
    .catch(err => {
        console.error("❌ Erro de conexão:", err.message);
        process.exit(1);
    });
