// routes/appointment.integration.js
/**
 * INTEGRAÇÃO 4.0 NAS ROTAS LEGADAS
 * 
 * Feature Flags:
 * - USE_EVENT_DRIVEN_CREATE
 * - USE_EVENT_DRIVEN_CANCEL  
 * - USE_EVENT_DRIVEN_COMPLETE
 * 
 * Estados de processamento:
 * - processing_create
 * - processing_cancel
 * - processing_complete
 */

import express from 'express';
import mongoose from 'mongoose';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import { isEnabled } from '../infrastructure/featureFlags/featureFlags.js';
import Appointment from '../models/Appointment.js';

const router = express.Router();

/**
 * 🎯 POST /appointments - Criação com Feature Flag
 * 
 * Fluxo 4.0:
 * 1. Valida entrada
 * 2. Marca como 'processing_create'
 * 3. Publica APPOINTMENT_CREATE_REQUESTED
 * 4. Retorna 202 (Accepted) - processamento async
 */
router.post('/', async (req, res) => {
    const useEventDriven = req.query.useEventDriven === 'true' || 
                          isEnabled('USE_EVENT_DRIVEN_CREATE', { userId: req.user?._id });

    if (!useEventDriven) {
        // Passa para próxima rota (legado)
        return res.status(501).json({
            success: false,
            error: 'Fluxo legado não implementado nesta rota',
            useEventDriven: false
        });
    }

    const mongoSession = await mongoose.startSession();
    
    try {
        await mongoSession.startTransaction();

        const {
            patientId,
            doctorId,
            date,
            time,
            specialty = 'fonoaudiologia',
            serviceType = 'session',
            packageId = null,
            insuranceGuideId = null,
            paymentMethod = 'dinheiro',
            amount = 0,
            notes = ''
        } = req.body;

        // Validações básicas
        if (!patientId || !doctorId || !date || !time) {
            await mongoSession.abortTransaction();
            return res.status(400).json({
                success: false,
                error: 'Campos obrigatórios: patientId, doctorId, date, time'
            });
        }

        // 1. Cria Appointment com status de processamento
        const appointment = new Appointment({
            patient: patientId,
            doctor: doctorId,
            date,
            time,
            specialty,
            serviceType,
            package: packageId,
            insuranceGuide: insuranceGuideId,
            
            // 🎯 ESTADO DE PROCESSAMENTO
            operationalStatus: 'processing_create',
            clinicalStatus: 'pending',
            paymentStatus: 'pending',
            
            sessionValue: amount,
            paymentMethod,
            billingType: insuranceGuideId ? 'convenio' : 'particular',
            
            notes,
            createdBy: req.user?._id,
            
            history: [{
                action: 'create_requested',
                newStatus: 'processing_create',
                changedBy: req.user?._id,
                timestamp: new Date(),
                context: 'Criação via event-driven 4.0'
            }]
        });

        await appointment.save({ session: mongoSession });

        // 2. Gera idempotencyKey
        const idempotencyKey = `${appointment._id}_create`;

        // 3. Commit para garantir que existe no DB
        await mongoSession.commitTransaction();

        // 4. Publica evento (fora da transação)
        const eventResult = await publishEvent(
            EventTypes.APPOINTMENT_CREATE_REQUESTED,
            {
                appointmentId: appointment._id.toString(),
                patientId: patientId?.toString(),
                doctorId: doctorId?.toString(),
                date,
                time,
                specialty,
                serviceType,
                packageId: packageId?.toString(),
                insuranceGuideId: insuranceGuideId?.toString(),
                amount,
                paymentMethod,
                notes,
                userId: req.user?._id?.toString()
            },
            {
                correlationId: appointment._id.toString(),
                idempotencyKey
            }
        );

        // 5. Retorna 202 Accepted (processamento async)
        res.status(202).json({
            success: true,
            message: 'Agendamento em processamento',
            data: {
                appointmentId: appointment._id.toString(),
                status: 'processing_create',
                correlationId: eventResult.correlationId,
                idempotencyKey: eventResult.idempotencyKey,
                eventId: eventResult.eventId
            },
            meta: {
                processing: 'async',
                estimatedTime: '1-3s',
                checkStatus: `GET /api/appointments/${appointment._id}/status`
            }
        });

    } catch (error) {
        await mongoSession.abortTransaction();
        console.error('[API:Create] Erro:', error.message);
        
        res.status(500).json({
            success: false,
            error: 'Erro ao criar agendamento',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    } finally {
        mongoSession.endSession();
    }
});

/**
 * 🎯 PATCH /appointments/:id/cancel - Cancelamento com Feature Flag
 * 
 * Fluxo 4.0:
 * 1. Verifica se já está processando
 * 2. Marca como 'processing_cancel'
 * 3. Publica APPOINTMENT_CANCEL_REQUESTED
 * 4. Retorna 202 (Accepted)
 */
router.patch('/:id/cancel', async (req, res) => {
    const useEventDriven = req.query.useEventDriven === 'true' || 
                          isEnabled('USE_EVENT_DRIVEN_CANCEL', { userId: req.user?._id });

    if (!useEventDriven) {
        return res.status(501).json({
            success: false,
            error: 'Fluxo legado não implementado',
            useEventDriven: false
        });
    }

    const mongoSession = await mongoose.startSession();

    try {
        await mongoSession.startTransaction();

        const { id } = req.params;
        const { reason, confirmedAbsence = false } = req.body;

        if (!reason) {
            await mongoSession.abortTransaction();
            return res.status(400).json({
                success: false,
                error: 'Motivo do cancelamento é obrigatório'
            });
        }

        // 1. Busca e verifica estado
        const appointment = await Appointment.findById(id).session(mongoSession);

        if (!appointment) {
            await mongoSession.abortTransaction();
            return res.status(404).json({
                success: false,
                error: 'Agendamento não encontrado'
            });
        }

        // 🛡️ Guard: já está processando?
        if (appointment.operationalStatus === 'processing_cancel') {
            await mongoSession.abortTransaction();
            return res.status(409).json({
                success: false,
                error: 'Cancelamento já em andamento',
                status: 'processing_cancel',
                checkStatus: `GET /api/appointments/${id}/status`
            });
        }

        // 🛡️ Guard: já cancelado?
        if (appointment.operationalStatus === 'canceled') {
            await mongoSession.abortTransaction();
            return res.status(409).json({
                success: false,
                error: 'Agendamento já cancelado',
                status: 'canceled'
            });
        }

        // 🛡️ Guard: já completado?
        if (appointment.clinicalStatus === 'completed') {
            await mongoSession.abortTransaction();
            return res.status(409).json({
                success: false,
                error: 'Não pode cancelar sessão já completada'
            });
        }

        // 2. Marca como processando
        appointment.operationalStatus = 'processing_cancel';
        appointment.history.push({
            action: 'cancel_requested',
            newStatus: 'processing_cancel',
            changedBy: req.user?._id,
            timestamp: new Date(),
            context: `Motivo: ${reason}`
        });

        await appointment.save({ session: mongoSession });

        // 3. Gera idempotencyKey
        const idempotencyKey = `${id}_cancel`;

        // 4. Commit
        await mongoSession.commitTransaction();

        // 5. Publica evento
        const eventResult = await publishEvent(
            EventTypes.APPOINTMENT_CANCEL_REQUESTED,
            {
                appointmentId: id,
                patientId: appointment.patient?.toString(),
                packageId: appointment.package?.toString(),
                reason,
                confirmedAbsence,
                userId: req.user?._id?.toString(),
                previousStatus: appointment.operationalStatus
            },
            {
                correlationId: id,
                idempotencyKey
            }
        );

        // 6. Retorna 202 Accepted
        res.status(202).json({
            success: true,
            message: 'Cancelamento em processamento',
            data: {
                appointmentId: id,
                status: 'processing_cancel',
                correlationId: eventResult.correlationId,
                idempotencyKey: eventResult.idempotencyKey,
                eventId: eventResult.eventId
            },
            meta: {
                processing: 'async',
                estimatedTime: '1-2s',
                checkStatus: `GET /api/appointments/${id}/status`
            }
        });

    } catch (error) {
        await mongoSession.abortTransaction();
        console.error('[API:Cancel] Erro:', error.message);
        
        res.status(500).json({
            success: false,
            error: 'Erro ao solicitar cancelamento'
        });
    } finally {
        mongoSession.endSession();
    }
});

/**
 * 🎯 PATCH /appointments/:id/complete - Complete com Feature Flag
 * 
 * Fluxo 4.0:
 * 1. Verifica se já está processando
 * 2. Marca como 'processing_complete'
 * 3. Publica APPOINTMENT_COMPLETE_REQUESTED
 * 4. Retorna 202 (Accepted)
 */
router.patch('/:id/complete', async (req, res) => {
    const useEventDriven = req.query.useEventDriven === 'true' || 
                          isEnabled('USE_EVENT_DRIVEN_COMPLETE', { userId: req.user?._id });

    if (!useEventDriven) {
        return res.status(501).json({
            success: false,
            error: 'Fluxo legado não implementado',
            useEventDriven: false
        });
    }

    const mongoSession = await mongoose.startSession();

    try {
        await mongoSession.startTransaction();

        const { id } = req.params;
        const { 
            addToBalance = false, 
            balanceAmount = 0, 
            balanceDescription = '' 
        } = req.body;

        // 1. Busca e verifica
        const appointment = await Appointment.findById(id).session(mongoSession);

        if (!appointment) {
            await mongoSession.abortTransaction();
            return res.status(404).json({
                success: false,
                error: 'Agendamento não encontrado'
            });
        }

        // 🛡️ Guard: já está processando?
        if (appointment.operationalStatus === 'processing_complete') {
            await mongoSession.abortTransaction();
            return res.status(409).json({
                success: false,
                error: 'Complete já em andamento',
                status: 'processing_complete',
                checkStatus: `GET /api/appointments/${id}/status`
            });
        }

        // 🛡️ Guard: já completado?
        if (appointment.clinicalStatus === 'completed') {
            await mongoSession.abortTransaction();
            return res.status(409).json({
                success: false,
                error: 'Agendamento já completado',
                status: 'completed',
                idempotent: true
            });
        }

        // 2. Marca como processando
        appointment.operationalStatus = 'processing_complete';
        appointment.history.push({
            action: 'complete_requested',
            newStatus: 'processing_complete',
            changedBy: req.user?._id,
            timestamp: new Date(),
            context: addToBalance ? `Fiado: ${balanceAmount}` : 'Complete normal'
        });

        await appointment.save({ session: mongoSession });

        // 3. Gera idempotencyKey
        const idempotencyKey = `${id}_complete_${addToBalance ? 'balance' : 'normal'}`;

        // 4. Commit
        await mongoSession.commitTransaction();

        // 5. Publica evento
        const eventResult = await publishEvent(
            EventTypes.APPOINTMENT_COMPLETE_REQUESTED,
            {
                appointmentId: id,
                patientId: appointment.patient?.toString(),
                doctorId: appointment.doctor?.toString(),
                packageId: appointment.package?.toString(),
                sessionId: appointment.session?.toString(),
                addToBalance,
                balanceAmount: balanceAmount || appointment.sessionValue,
                balanceDescription,
                userId: req.user?._id?.toString(),
                previousStatus: appointment.operationalStatus
            },
            {
                correlationId: id,
                idempotencyKey
            }
        );

        // 6. Retorna 202 Accepted
        res.status(202).json({
            success: true,
            message: 'Complete em processamento',
            data: {
                appointmentId: id,
                status: 'processing_complete',
                correlationId: eventResult.correlationId,
                idempotencyKey: eventResult.idempotencyKey,
                eventId: eventResult.eventId
            },
            meta: {
                processing: 'async',
                estimatedTime: '1-3s',
                checkStatus: `GET /api/appointments/${id}/status`
            }
        });

    } catch (error) {
        await mongoSession.abortTransaction();
        console.error('[API:Complete] Erro:', error.message);
        
        res.status(500).json({
            success: false,
            error: 'Erro ao solicitar complete'
        });
    } finally {
        mongoSession.endSession();
    }
});

/**
 * 🎯 GET /appointments/:id/status - Consulta status (para polling)
 */
router.get('/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        
        const appointment = await Appointment.findById(id)
            .select('operationalStatus clinicalStatus paymentStatus session package patient correlationId canceledReason');

        if (!appointment) {
            return res.status(404).json({ error: 'Agendamento não encontrado' });
        }

        // Determina se está em processamento
        const isProcessing = 
            appointment.operationalStatus === 'processing_create' ||
            appointment.operationalStatus === 'processing_cancel' ||
            appointment.operationalStatus === 'processing_complete';

        res.json({
            appointmentId: id,
            operationalStatus: appointment.operationalStatus,
            clinicalStatus: appointment.clinicalStatus,
            paymentStatus: appointment.paymentStatus,
            isProcessing,
            isCompleted: appointment.clinicalStatus === 'completed',
            isCanceled: appointment.operationalStatus === 'canceled',
            canCancel: 
                appointment.operationalStatus !== 'canceled' &&
                appointment.clinicalStatus !== 'completed' &&
                !isProcessing,
            canComplete:
                appointment.operationalStatus !== 'canceled' &&
                appointment.clinicalStatus !== 'completed' &&
                !isProcessing,
            canceledReason: appointment.canceledReason,
            correlationId: appointment.correlationId,
            hasSession: !!appointment.session,
            hasPackage: !!appointment.package,
            processingInfo: isProcessing ? {
                message: 'Processamento em andamento',
                retryIn: '2s'
            } : null
        });

    } catch (error) {
        console.error('[API:Status] Erro:', error.message);
        res.status(500).json({ error: 'Erro interno' });
    }
});

export default router;
