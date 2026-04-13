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
        
        // Buscar payment vinculado
        let payment = null;
        if (appointment.payment) {
            payment = await Payment.findById(appointment.payment);
        } else {
            // Tentar buscar por appointment
            payment = await Payment.findOne({ appointment: id });
        }
        
        // Determinar status correto
        let correctStatus = 'pending';
        let correctFlag = 'pending';
        let paymentId = null;
        
        if (payment) {
            paymentId = payment._id.toString();
            if (payment.status === 'paid') {
                correctStatus = 'paid';
                correctFlag = 'ok';
            } else if (payment.status === 'pending') {
                correctStatus = 'pending';
                correctFlag = 'pending';
            }
        }
        
        // Só atualiza se estiver diferente
        const needsUpdate = appointment.paymentStatus !== correctStatus || 
                           appointment.visualFlag !== correctFlag ||
                           !appointment.payment;
        
        if (needsUpdate) {
            await Appointment.findByIdAndUpdate(id, {
                paymentStatus: correctStatus,
                visualFlag: correctFlag,
                ...(payment && !appointment.payment && { payment: payment._id }),
                updatedAt: new Date()
            });
            
            return res.json({
                success: true,
                synced: true,
                before: {
                    paymentStatus: appointment.paymentStatus,
                    visualFlag: appointment.visualFlag
                },
                after: {
                    paymentStatus: correctStatus,
                    visualFlag: correctFlag
                },
                paymentId
            });
        }
        
        return res.json({
            success: true,
            synced: false,
            message: 'Já está sincronizado',
            current: {
                paymentStatus: appointment.paymentStatus,
                visualFlag: appointment.visualFlag
            }
        });
        
    } catch (error) {
        console.error('[Sync] Erro:', error);
        res.status(500).json({ error: error.message });
    }
});

export default router;
