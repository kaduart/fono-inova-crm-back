// routes/preAgendamento.v2.js
/**
 * Rotas V2 para Pré-Agendamento - Event-driven
 * 
 * GET  /v2/pre-agendamento           → Lista pré-agendamentos (query)
 * POST /v2/pre-agendamento           → Cria pré-agendamento (event)
 * POST /v2/pre-agendamento/:id/importar → Importa como appointment (event)
 * PATCH /v2/pre-agendamento/:id/status → Atualiza status (event)
 */

import express from 'express';
import mongoose from 'mongoose';
import { auth } from '../middleware/auth.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import Appointment from '../models/Appointment.js';

const router = express.Router();

// ======================================================
// GET /v2/pre-agendamento - Lista pré-agendamentos
// ======================================================
router.get('/', auth, async (req, res) => {
    try {
        const { limit = 50, status, phone, from, to } = req.query;
        
        const query = { type: 'pre-agendamento' };
        
        if (status) {
            query.status = { $in: status.split(',') };
        }
        if (phone) {
            query['patientInfo.phone'] = { $regex: phone, $options: 'i' };
        }
        if (from || to) {
            query.preferredDate = {};
            if (from) query.preferredDate.$gte = new Date(from);
            if (to) query.preferredDate.$lte = new Date(to);
        }
        
        const preAgendamentos = await Appointment.find(query)
            .sort({ createdAt: -1 })
            .limit(parseInt(limit))
            .lean();

        res.json({
            success: true,
            data: preAgendamentos,
            count: preAgendamentos.length
        });

    } catch (error) {
        console.error('[PreAgendamentoV2] Erro ao listar:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao listar pré-agendamentos: ' + error.message
        });
    }
});

// ======================================================
// POST /v2/pre-agendamento - Cria pré-agendamento (event-driven)
// ======================================================
router.post('/', auth, async (req, res) => {
    try {
        const { patientInfo, preferredDate, preferredTime, specialty, notes } = req.body;
        
        if (!patientInfo?.name || !preferredDate) {
            return res.status(400).json({
                success: false,
                error: 'Nome do paciente e data preferida são obrigatórios'
            });
        }

        const correlationId = `preagendamento_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        const eventResult = await publishEvent(
            EventTypes.PREAGENDAMENTO_CREATED,
            {
                patientInfo,
                preferredDate,
                preferredTime,
                specialty,
                notes,
                status: 'novo',
                source: 'manual',
                createdBy: req.user?._id?.toString(),
                createdAt: new Date().toISOString()
            },
            {
                correlationId,
                aggregateType: 'preagendamento',
                aggregateId: correlationId,
                metadata: {
                    source: 'preagendamento_api_v2',
                    userId: req.user?._id?.toString()
                }
            }
        );

        res.status(202).json({
            success: true,
            message: 'Pré-agendamento enfileirado para processamento',
            data: {
                eventId: eventResult.eventId,
                correlationId,
                status: 'pending'
            }
        });

    } catch (error) {
        console.error('[PreAgendamentoV2] Erro ao criar:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao criar pré-agendamento: ' + error.message
        });
    }
});

// ======================================================
// POST /v2/pre-agendamento/:id/importar - Importa como appointment
// ======================================================
router.post('/:id/importar', auth, async (req, res) => {
    try {
        const { id } = req.params;
        const { doctorId, date, time, notes } = req.body;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({
                success: false,
                error: 'ID inválido'
            });
        }

        const correlationId = `importar_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        const eventResult = await publishEvent(
            EventTypes.PREAGENDAMENTO_IMPORTED,
            {
                preAgendamentoId: id,
                doctorId,
                date,
                time,
                notes,
                importedBy: req.user?._id?.toString(),
                importedAt: new Date().toISOString()
            },
            {
                correlationId,
                aggregateType: 'preagendamento',
                aggregateId: id,
                metadata: {
                    source: 'preagendamento_import_v2',
                    userId: req.user?._id?.toString()
                }
            }
        );

        res.status(202).json({
            success: true,
            message: 'Importação enfileirada para processamento',
            data: {
                eventId: eventResult.eventId,
                correlationId,
                status: 'pending'
            }
        });

    } catch (error) {
        console.error('[PreAgendamentoV2] Erro ao importar:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao importar pré-agendamento: ' + error.message
        });
    }
});

// ======================================================
// PATCH /v2/pre-agendamento/:id/status - Atualiza status
// ======================================================
router.patch('/:id/status', auth, async (req, res) => {
    try {
        const { id } = req.params;
        const { status, reason } = req.body;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({
                success: false,
                error: 'ID inválido'
            });
        }

        const validStatuses = ['novo', 'em_analise', 'contatado', 'agendado', 'cancelado'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({
                success: false,
                error: 'Status inválido'
            });
        }

        const correlationId = `status_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        const eventResult = await publishEvent(
            EventTypes.PREAGENDAMENTO_STATUS_CHANGED,
            {
                preAgendamentoId: id,
                status,
                reason,
                changedBy: req.user?._id?.toString(),
                changedAt: new Date().toISOString()
            },
            {
                correlationId,
                aggregateType: 'preagendamento',
                aggregateId: id,
                metadata: {
                    source: 'preagendamento_status_v2',
                    userId: req.user?._id?.toString()
                }
            }
        );

        res.status(202).json({
            success: true,
            message: 'Atualização de status enfileirada',
            data: {
                eventId: eventResult.eventId,
                correlationId,
                status: 'pending'
            }
        });

    } catch (error) {
        console.error('[PreAgendamentoV2] Erro ao atualizar status:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao atualizar status: ' + error.message
        });
    }
});

export default router;
