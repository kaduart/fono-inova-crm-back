/**
 * 🔧 ENDPOINT DE SINCRONIZAÇÃO DE PAYMENT STATUS
 * 
 * Corrige des sincronização entre Appointment e Payment
 * após complete (race condition no background)
 */

import express from 'express';
import Appointment from '../models/Appointment.js';
import Payment from '../models/Payment.js';

const router = express.Router();

/**
 * PATCH /api/sync/appointment/:id/payment-status
 * 
 * Sincroniza o paymentStatus do Appointment baseado no Payment real
 */
router.patch('/appointment/:id/payment-status', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Buscar appointment
        const appointment = await Appointment.findById(id);
        if (!appointment) {
            return res.status(404).json({ error: 'Appointment não encontrado' });
        }
        
        // Buscar TODOS os payments do appointment (suporte a split)
        const allPayments = await Payment.find({
            $or: [
                { appointment: id },
                { appointmentId: id.toString() }
            ],
            isFromPackage: { $ne: true },
            status: { $nin: ['canceled', 'refunded', 'converted_to_package'] }
        }).lean();

        // Determinar status correto
        let correctStatus = 'pending';
        let correctFlag = 'pending';
        let paymentId = null;

        if (allPayments.length > 0) {
            // session_charge é o registro mestre — se existir, é a fonte de verdade
            const charge = allPayments.find(p => p.kind === 'session_charge');
            const authoritative = charge || null;

            if (authoritative) {
                paymentId = authoritative._id.toString();
                if (authoritative.status === 'paid') {
                    correctStatus = 'paid';
                    correctFlag = 'ok';
                } else {
                    correctStatus = 'pending';
                    correctFlag = 'pending';
                }
            } else {
                // Sem session_charge: verifica se TODOS os session_payments estão pagos
                const allPaid = allPayments.every(p => p.status === 'paid');
                const anyPaid = allPayments.some(p => p.status === 'paid');
                paymentId = allPayments[0]._id.toString();

                if (allPaid) {
                    correctStatus = 'paid';
                    correctFlag = 'ok';
                } else if (anyPaid) {
                    correctStatus = 'pending';
                    correctFlag = 'partial';
                } else {
                    correctStatus = 'pending';
                    correctFlag = 'pending';
                }
            }
        }
        
        // Só atualiza se estiver diferente
        const correctIsPaid = correctStatus === 'paid';
        const needsUpdate = appointment.paymentStatus !== correctStatus ||
                           appointment.visualFlag !== correctFlag ||
                           appointment.isPaid !== correctIsPaid;

        if (needsUpdate) {
            await Appointment.findByIdAndUpdate(id, {
                paymentStatus: correctStatus,
                visualFlag: correctFlag,
                isPaid: correctIsPaid,
                updatedAt: new Date()
            });
            
            return res.json({
                success: true,
                synced: true,
                paymentsEvaluated: allPayments.length,
                before: {
                    paymentStatus: appointment.paymentStatus,
                    visualFlag: appointment.visualFlag,
                    isPaid: appointment.isPaid
                },
                after: {
                    paymentStatus: correctStatus,
                    visualFlag: correctFlag,
                    isPaid: correctIsPaid
                },
                paymentId
            });
        }

        return res.json({
            success: true,
            synced: false,
            message: 'Já está sincronizado',
            paymentsEvaluated: allPayments.length,
            current: {
                paymentStatus: appointment.paymentStatus,
                visualFlag: appointment.visualFlag,
                isPaid: appointment.isPaid
            }
        });
        
    } catch (error) {
        console.error('[Sync] Erro:', error);
        res.status(500).json({ error: error.message });
    }
});

export default router;
