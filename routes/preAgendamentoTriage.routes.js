/**
 * Rotas de triagem comercial de pré-agendamentos.
 *
 * `pre_agendado` é um valor de `operationalStatus` do próprio `Appointment` —
 * não existe mais uma entidade `PreAppointment` separada (unificação anterior
 * a 2026-05). Este arquivo é uma fachada especializada sobre `Appointment`
 * para o fluxo de triagem da secretária: listar, confirmar, descartar,
 * registrar contato e atribuir. Não é um domínio próprio.
 *
 * Substitui `routes/preAgendamento.engine.js` (removido em 2026-07-15), que
 * também tinha `GET /:id`, `POST /` (criar), `PATCH /:id` e `POST /:id/cancel`
 * — removidos por falta de consumidor, já cobertos por `appointment.v2.js`.
 *
 * Ver `docs/architecture/CANONICAL_FILES.md` para o inventário completo.
 */

import express from 'express';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { flexibleAuth } from '../middleware/amandaAuth.js';
import { eventExists } from '../infrastructure/events/eventStoreService.js';
import EventStore from '../models/EventStore.js';
import { cancelAppointment, confirmPreAgendamento } from '../services/appointmentV2Service.js';
import Appointment from '../models/Appointment.js';
import { mapAppointmentDTO } from '../utils/appointmentDto.js';

const router = express.Router();

// ======================================================
// 🔒 IDEMPOTENCY HELPERS
// ======================================================
function getRequestId(req) {
    return req.headers['x-client-request-id'] || req.headers['x-idempotency-key'] || null;
}

async function markIdempotency(requestId) {
    if (!requestId) return;
    await EventStore.create({
        eventId: crypto.randomUUID(),
        eventType: 'IDEMPOTENCY_KEY_REGISTERED',
        aggregateType: 'system',
        aggregateId: requestId,
        payload: { registeredAt: new Date() },
        idempotencyKey: `req_${requestId}`,
        status: 'processed'
    });
}

// ======================================================
// GET /api/v2/pre-appointments - Lista pré-agendamentos
// ======================================================
router.get('/', flexibleAuth, async (req, res) => {
    try {
        const { limit = 50, page = 1, status, phone, from, to, doctorId, specialty } = req.query;

        const query = { operationalStatus: 'pre_agendado' };

        if (status) {
            query.status = { $in: status.split(',') };
        }
        if (phone) {
            query['patientInfo.phone'] = { $regex: phone.replace(/\D/g, ''), $options: 'i' };
        }
        // Filtra por data da consulta (fuso BRT) — sem filtro usa hoje como padrão
        const dateFrom = from || new Date().toISOString().split('T')[0];
        query.date = {};
        query.date.$gte = new Date(dateFrom + 'T00:00:00-03:00');
        if (to) query.date.$lte = new Date(to + 'T23:59:59-03:00');

        if (specialty && specialty !== 'todas') {
            query.specialty = specialty.toLowerCase();
        }
        if (doctorId && mongoose.Types.ObjectId.isValid(doctorId)) {
            query.doctor = doctorId;
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const [preAppointments, total] = await Promise.all([
            Appointment.find(query)
                .populate('doctor', 'fullName specialty')
                .populate('patient', 'fullName phone dateOfBirth email')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit))
                .lean(),
            Appointment.countDocuments(query)
        ]);

        res.json({
            success: true,
            data: preAppointments.map(mapAppointmentDTO),
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / parseInt(limit))
            }
        });

    } catch (error) {
        console.error('[PreAgendamentoTriage] Erro ao listar:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao listar pré-agendamentos: ' + error.message
        });
    }
});

// ======================================================
// POST /api/v2/pre-appointments/:id/confirm - CONFIRMA
// ======================================================
router.post('/:id/confirm', flexibleAuth, async (req, res) => {
    try {
        const requestId = getRequestId(req);
        if (requestId && await eventExists(`req_${requestId}`)) {
            return res.status(200).json({
                success: true,
                skipped: true,
                reason: 'idempotent_request'
            });
        }

        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, error: 'ID inválido' });
        }

        // Delega ao command canônico: transição in-place do mesmo Appointment
        // (pre_agendado -> scheduled), sem criar um segundo documento. Antes,
        // esse endpoint criava um Appointment novo via appointmentHybridService
        // e cancelava o original — padrão que já causou duplicação de registros
        // em produção (ver agenda/BACKEND_CLEANUP_REQUIRED.md).
        const result = await confirmPreAgendamento(id, req.body, req.user);
        await markIdempotency(requestId);

        res.json({
            success: true,
            message: result.message,
            skipped: result.skipped || false,
            data: {
                appointmentId: result.data._id,
                sessionId: result.data.session?._id || result.data.session || null,
                paymentId: result.data.payment?._id || result.data.payment || null,
                patientId: result.data.patient?._id || result.data.patient || null,
            }
        });

    } catch (error) {
        console.error('[PreAgendamentoTriage] Erro ao confirmar:', error);
        const status = error.status || 500;
        res.status(status).json({
            success: false,
            error: error.message || 'Erro ao confirmar pré-agendamento',
            code: error.code || 'INTERNAL_SERVER_ERROR',
        });
    }
});

// ======================================================
// POST /api/v2/pre-appointments/:id/discard - Descarta pré-agendamento
// ======================================================
router.post('/:id/discard', flexibleAuth, async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, error: 'ID inválido' });
        }

        const { reason } = req.body;

        // Delega ao command canônico (transação + cancela Session vinculada +
        // libera o slot).
        await cancelAppointment(id, { reason: reason || 'Pré-agendamento descartado' }, req.user);

        const pre = await Appointment.findByIdAndUpdate(
            id,
            {
                discardReason: reason,
                discardedAt: new Date(),
                discardedBy: req.user?._id?.toString()
            },
            { new: true }
        )
            .populate('patient', 'fullName phone dateOfBirth email')
            .populate('doctor', 'fullName specialty')
            .lean();

        if (!pre) {
            return res.status(404).json({ success: false, error: 'Pré-agendamento não encontrado' });
        }

        res.json({ success: true, message: 'Descartado com sucesso', data: mapAppointmentDTO(pre) });
    } catch (error) {
        console.error('[PreAgendamentoTriage] Erro ao descartar:', error);
        const status = error.status || 500;
        res.status(status).json({
            success: false,
            error: error.message || 'Erro ao descartar pré-agendamento',
            code: error.code || 'INTERNAL_SERVER_ERROR',
        });
    }
});

// ======================================================
// GET /api/v2/pre-appointments/stats/dashboard — Stats do painel de pré-agendamentos
// ======================================================
router.get('/stats/dashboard', flexibleAuth, async (req, res) => {
    try {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        const [porUrgencia, urgentes, semContato, total, porEspecialidade, conversao, porPatientType] = await Promise.all([
            Appointment.aggregate([
                { $match: { operationalStatus: 'pre_agendado' } },
                { $group: { _id: '$urgency', count: { $sum: 1 } } }
            ]),
            Appointment.countDocuments({
                operationalStatus: 'pre_agendado',
                urgency: { $in: ['alta', 'critica'] }
            }),
            Appointment.countDocuments({
                operationalStatus: 'pre_agendado',
                $or: [{ attemptCount: 0 }, { attemptCount: { $exists: false } }]
            }),
            Appointment.countDocuments({ operationalStatus: 'pre_agendado' }),
            Appointment.aggregate([
                { $match: { operationalStatus: 'pre_agendado' } },
                { $group: { _id: '$specialty', count: { $sum: 1 } } }
            ]),
            Appointment.aggregate([
                {
                    $match: {
                        'metadata.origin.source': { $in: ['agenda_externa', 'amandaAI'] },
                        createdAt: { $gte: thirtyDaysAgo }
                    }
                },
                {
                    $group: {
                        _id: null,
                        total: { $sum: 1 },
                        importados: {
                            $sum: { $cond: [{ $in: ['$operationalStatus', ['scheduled', 'confirmed', 'paid']] }, 1, 0] }
                        }
                    }
                }
            ]),
            Appointment.aggregate([
                {
                    $match: {
                        patientType: { $in: ['novo', 'retorno', 'recorrente'] },
                        createdAt: { $gte: thirtyDaysAgo }
                    }
                },
                { $group: { _id: '$patientType', count: { $sum: 1 } } }
            ])
        ]);

        const conv = conversao[0] || { total: 0, importados: 0 };
        const porUrgenciaMap = porUrgencia.reduce((acc, item) => { acc[item._id] = item.count; return acc; }, {});
        const patientTypeMap = porPatientType.reduce((acc, item) => { acc[item._id] = item.count; return acc; }, {});

        res.json({
            success: true,
            data: {
                porUrgencia: porUrgenciaMap,
                porStatus: porUrgenciaMap,
                urgentes,
                semContato,
                total,
                porEspecialidade,
                conversao: {
                    taxa: conv.total > 0 ? Math.round((conv.importados / conv.total) * 100) : 0,
                    total: conv.total,
                    importados: conv.importados
                },
                novos: patientTypeMap['novo'] || 0,
                retornos: patientTypeMap['retorno'] || 0,
                recorrentes: patientTypeMap['recorrente'] || 0
            }
        });
    } catch (error) {
        console.error('[PreAgendamentoTriage] Erro ao buscar stats:', error);
        res.status(500).json({ success: false, error: 'Erro ao buscar estatísticas: ' + error.message });
    }
});

// ======================================================
// POST /api/v2/pre-appointments/:id/contact - Registra tentativa de contato
// ======================================================
router.post('/:id/contact', flexibleAuth, async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, error: 'ID inválido' });
        }

        const { channel, success, notes } = req.body;
        const madeByUserId = req.user?._id?.toString?.() || null;

        const pre = await Appointment.findByIdAndUpdate(
            id,
            {
                $push: {
                    contactAttempts: {
                        date: new Date(),
                        channel,
                        success: !!success,
                        notes,
                        madeBy: madeByUserId
                    }
                },
                $inc: { attemptCount: 1 },
                updatedAt: new Date()
            },
            { new: true }
        );

        if (!pre) {
            return res.status(404).json({ success: false, error: 'Pré-agendamento não encontrado' });
        }

        res.json({ success: true, data: mapAppointmentDTO(pre) });
    } catch (error) {
        console.error('[PreAgendamentoTriage] Erro ao registrar contato:', error);
        res.status(500).json({ success: false, error: 'Erro ao registrar contato: ' + error.message });
    }
});

// ======================================================
// POST /api/v2/pre-appointments/:id/assign - Atribui pré-agendamento a um usuário
// ======================================================
router.post('/:id/assign', flexibleAuth, async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, error: 'ID inválido' });
        }

        const { userId } = req.body;
        const assignedUserId = (userId && mongoose.Types.ObjectId.isValid(userId)) ? userId :
            (req.user?._id?.toString?.() || null);

        const pre = await Appointment.findByIdAndUpdate(
            id,
            { assignedTo: assignedUserId, updatedAt: new Date() },
            { new: true }
        );

        if (!pre) {
            return res.status(404).json({ success: false, error: 'Pré-agendamento não encontrado' });
        }

        res.json({ success: true, data: mapAppointmentDTO(pre) });
    } catch (error) {
        console.error('[PreAgendamentoTriage] Erro ao atribuir:', error);
        res.status(500).json({ success: false, error: 'Erro ao atribuir pré-agendamento: ' + error.message });
    }
});

export default router;
