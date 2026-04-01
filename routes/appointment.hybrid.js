// routes/appointment.hybrid.js
import express from 'express';
import mongoose from 'mongoose';
import { appointmentHybridService } from '../services/appointmentHybridService.js';
import { appointmentCompleteService } from '../services/appointmentCompleteService.js';
import { isEnabled } from '../infrastructure/featureFlags/featureFlags.js';

/**
 * ROTAS HYBRID - Agendamento + Complete
 * 
 * Feature Flag: USE_HYBRID_FLOW
 * - true: usa serviços híbridos (inteligente)
 * - false: passa para próxima rota (legado)
 */

const router = express.Router();

/**
 * POST /appointments
 * 
 * Cria agendamento no modo HYBRID:
 * - Sempre cria Appointment + Session
 * - SÓ cria Payment se PARTICULAR + amount > 0
 * - NÃO cria Payment para pacote/convênio
 */
router.post('/', async (req, res) => {
    // Feature flag
    const useHybrid = req.query.useHybrid === 'true' || 
                      isEnabled('USE_HYBRID_FLOW', { userId: req.user?._id });

    if (!useHybrid) {
        // Passa para próxima rota (legado)
        return res.status(501).json({
            success: false,
            message: 'Fluxo legado não implementado nesta rota',
            useHybrid: false
        });
    }

    const mongoSession = await mongoose.startSession();
    
    try {
        await mongoSession.startTransaction();

        const result = await appointmentHybridService.create(req.body, mongoSession);

        await mongoSession.commitTransaction();

        res.status(201).json({
            success: true,
            message: result.message,
            data: result
        });

    } catch (error) {
        await mongoSession.abortTransaction();
        
        console.error('[HYBRID] Erro ao criar agendamento:', error.message);
        
        res.status(500).json({
            success: false,
            error: error.message
        });
    } finally {
        mongoSession.endSession();
    }
});

/**
 * PATCH /appointments/:id/complete
 * 
 * Completa a sessão (AQUI acontece a mágica):
 * - Atualiza Session para completed
 * - Consome pacote (se houver)
 * - Processa/atualiza Payment
 * - Atualiza Appointment
 */
router.patch('/:id/complete', async (req, res) => {
    const useHybrid = req.query.useHybrid === 'true' || 
                      isEnabled('USE_HYBRID_FLOW', { userId: req.user?._id });

    if (!useHybrid) {
        return res.status(501).json({
            success: false,
            message: 'Fluxo legado não implementado',
            useHybrid: false
        });
    }

    const mongoSession = await mongoose.startSession();

    try {
        await mongoSession.startTransaction();

        const result = await appointmentCompleteService.complete(
            req.params.id,
            req.body,
            mongoSession
        );

        await mongoSession.commitTransaction();

        res.json({
            success: true,
            message: 'Sessão completada com sucesso',
            data: result
        });

    } catch (error) {
        await mongoSession.abortTransaction();
        
        console.error('[HYBRID] Erro ao completar:', error.message);
        
        res.status(500).json({
            success: false,
            error: error.message
        });
    } finally {
        mongoSession.endSession();
    }
});

export default router;
