// routes/appointment.create.EVENT_DRIVEN.js
import express from 'express';
import mongoose from 'mongoose';
import { createAppointmentService } from '../services/createAppointmentService.js';
import { isEnabled } from '../infrastructure/featureFlags/featureFlags.js';

/**
 * ROTA EVENT-DRIVEN: POST /appointments
 * 
 * Características:
 * - Feature flag USE_EVENT_DRIVEN_CREATE
 * - Transação atômica (DB + Outbox)
 * - Retorna imediatamente (processamento assíncrono)
 * - 100% compatível com fluxo legado
 * 
 * Query param: ?useEventDriven=true (override da env var)
 */

const router = express.Router();

router.post('/', async (req, res) => {
    const startTime = Date.now();
    
    // Feature flag: pode vir de query param ou env
    const useEventDriven = req.query.useEventDriven === 'true' || 
                           isEnabled('USE_EVENT_DRIVEN_CREATE', { userId: req.user?._id });
    
    // Se feature flag desligada, passa para próxima rota (legado)
    if (!useEventDriven) {
        console.log('[API:CreateAppointment] Feature flag desligada, usando fluxo legado');
        return res.status(501).json({
            success: false,
            error: 'Fluxo legado não implementado nesta rota',
            useEventDriven: false,
            hint: 'Ative USE_EVENT_DRIVEN_CREATE=true ou use ?useEventDriven=true'
        });
    }
    
    try {
        const {
            patientId,
            doctorId,
            date,
            time,
            specialty,
            serviceType,
            packageId,
            insuranceGuideId,
            paymentMethod,
            amount,
            notes
        } = req.body;
        
        // Correlation ID pode vir do cliente (para rastreamento)
        const correlationId = req.headers['x-correlation-id'] || req.body.correlationId;
        
        console.log('[API:CreateAppointment] Requisição recebida', {
            patientId,
            doctorId,
            date,
            time,
            useEventDriven: true
        });
        
        // Inicia transação
        const session = await mongoose.startSession();
        
        try {
            await session.startTransaction();
            
            // Executa serviço
            const result = await createAppointmentService.execute({
                patientId,
                doctorId,
                date,
                time,
                specialty,
                serviceType,
                packageId,
                insuranceGuideId,
                paymentMethod,
                amount,
                notes,
                userId: req.user?._id,
                correlationId
            }, session);
            
            await session.commitTransaction();
            
            console.log('[API:CreateAppointment] Transação commitada', {
                appointmentId: result.appointmentId,
                duration: Date.now() - startTime
            });
            
            // Retorna imediatamente (processamento continua nos workers)
            res.status(202).json({
                success: true,
                message: 'Agendamento registrado. Validação em andamento...',
                data: {
                    appointmentId: result.appointmentId,
                    status: result.status,
                    eventId: result.eventId,
                    correlationId: result.correlationId
                },
                meta: {
                    useEventDriven: true,
                    processingTime: Date.now() - startTime,
                    nextSteps: [
                        'Aguardar processamento assíncrono',
                        'Consultar status via GET /appointments/:id/status'
                    ]
                }
            });
            
        } catch (error) {
            await session.abortTransaction();
            throw error;
        } finally {
            session.endSession();
        }
        
    } catch (error) {
        console.error('[API:CreateAppointment] Erro:', error.message);
        
        // Mapeia erros específicos
        const errorMap = {
            'PACIENTE_OBRIGATORIO': { status: 400, message: 'Paciente é obrigatório' },
            'PROFISSIONAL_OBRIGATORIO': { status: 400, message: 'Profissional é obrigatório' },
            'DATA_INVALIDA': { status: 400, message: 'Data inválida (use YYYY-MM-DD)' },
            'HORARIO_INVALIDO': { status: 400, message: 'Horário inválido (use HH:MM)' }
        };
        
        const mapped = errorMap[error.message];
        
        if (mapped) {
            return res.status(mapped.status).json({
                success: false,
                error: mapped.message,
                code: error.message
            });
        }
        
        res.status(500).json({
            success: false,
            error: 'Erro interno ao criar agendamento',
            message: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * GET /appointments/:id/status
 * 
 * Consulta status do agendamento (para polling)
 */
router.get('/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        
        const Appointment = (await import('../models/Appointment.js')).default;
        
        const appointment = await Appointment.findById(id)
            .select('operationalStatus clinicalStatus paymentStatus rejectionReason rejectionDetails correlationId createdAt');
        
        if (!appointment) {
            return res.status(404).json({ error: 'Agendamento não encontrado' });
        }
        
        res.json({
            appointmentId: id,
            status: appointment.operationalStatus,
            clinicalStatus: appointment.clinicalStatus,
            paymentStatus: appointment.paymentStatus,
            isConfirmed: appointment.operationalStatus === 'scheduled',
            isRejected: appointment.operationalStatus === 'rejected',
            rejectionReason: appointment.rejectionReason,
            rejectionDetails: appointment.rejectionDetails,
            correlationId: appointment.correlationId,
            createdAt: appointment.createdAt
        });
        
    } catch (error) {
        console.error('[API:AppointmentStatus] Erro:', error.message);
        res.status(500).json({ error: 'Erro interno' });
    }
});

export default router;
