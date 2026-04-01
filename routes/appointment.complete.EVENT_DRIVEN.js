/**
 * ROTA EVENT-DRIVEN: PATCH /:id/complete
 * 
 * Esta é a versão nova (event-driven) do endpoint de complete.
 * Ela coexiste com a versão original (appointment.complete.OPTIMIZED.js)
 * permitindo migração gradual.
 * 
 * Características:
 * - Transação mínima (apenas dados críticos)
 * - Elimina o "gap" de Payment (criação via worker)
 * - PatientBalance via fila (atomic $inc)
 * - 100% idempotente
 * 
 * Query param para escolher implementação:
 * ?useEventDriven=true → usa esta versão
 */

import express from 'express';
import { auth } from '../middleware/auth.js';
import { completeSessionEventDriven } from '../services/completeSessionEventService.js';
import Appointment from '../models/Appointment.js';

const router = express.Router();

/**
 * PATCH /:id/complete
 * 
 * Headers opcionais:
 * - X-Idempotency-Key: chave para garantir idempotência
 * - X-Correlation-Id: correlation ID customizado
 * 
 * Body:
 * - addToBalance: boolean
 * - balanceAmount: number
 * - balanceDescription: string
 */
router.patch('/:id/complete', auth, async (req, res) => {
    const startTime = Date.now();
    
    try {
        const { id } = req.params;
        const { 
            addToBalance = false, 
            balanceAmount = 0, 
            balanceDescription = '' 
        } = req.body;
        
        // Idempotency key do cliente (opcional)
        const idempotencyKey = req.headers['x-idempotency-key'];
        const correlationId = req.headers['x-correlation-id'];
        
        console.log(`[API:Complete] Requisição recebida`, {
            appointmentId: id,
            addToBalance,
            idempotencyKey,
            correlationId
        });
        
        // Chama serviço event-driven
        const result = await completeSessionEventDriven(id, {
            addToBalance,
            balanceAmount,
            balanceDescription,
            userId: req.user?._id,
            correlationId
        });
        
        // Se foi idempotente, retorna 200 em vez de 201
        const statusCode = result.idempotent ? 200 : 200;
        
        // Retorna correlationId para rastreamento
        res.status(statusCode).json({
            success: true,
            ...result,
            processingTime: Date.now() - startTime,
            _meta: {
                version: 'event-driven-v1',
                idempotencyKey,
                correlationId: result.correlationId
            }
        });
        
    } catch (error) {
        console.error(`[API:Complete] Erro:`, error.message);
        
        // Erros específicos
        if (error.message === 'Agendamento não encontrado') {
            return res.status(404).json({
                success: false,
                error: 'Agendamento não encontrado'
            });
        }
        
        res.status(500).json({
            success: false,
            error: 'Erro interno no servidor',
            message: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * GET /:id/status
 * 
 * Verifica status do complete e eventos associados
 * Útil para polling após o complete (async)
 */
router.get('/:id/complete-status', auth, async (req, res) => {
    try {
        const { id } = req.params;
        const { correlationId } = req.query;
        
        const appointment = await Appointment.findById(id)
            .select('clinicalStatus paymentStatus correlationId paymentOrigin addedToBalance balanceAmount');
        
        if (!appointment) {
            return res.status(404).json({ error: 'Agendamento não encontrado' });
        }
        
        res.json({
            appointmentId: id,
            clinicalStatus: appointment.clinicalStatus,
            paymentStatus: appointment.paymentStatus,
            paymentOrigin: appointment.paymentOrigin,
            correlationId: appointment.correlationId || correlationId,
            balanceInfo: appointment.addedToBalance ? {
                added: true,
                amount: appointment.balanceAmount
            } : null,
            isComplete: appointment.clinicalStatus === 'completed'
        });
        
    } catch (error) {
        console.error(`[API:CompleteStatus] Erro:`, error.message);
        res.status(500).json({ error: 'Erro interno' });
    }
});

export default router;
