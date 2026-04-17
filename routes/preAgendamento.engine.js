/**
 * 🔥 PRE-APPOINTMENT V2 ENGINE
 * 
 * Rotas V2 OFICIAIS de pré-agendamento.
 * Síncronas, transacionais e idempotentes.
 * Único ponto de entrada para Agenda Externa → CRM Core V2.
 */

import express from 'express';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { flexibleAuth } from '../middleware/amandaAuth.js';
import { eventExists } from '../infrastructure/events/eventStoreService.js';
import EventStore from '../models/EventStore.js';
import { appointmentHybridService } from '../services/appointmentHybridService.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import Appointment from '../models/Appointment.js';
import Patient from '../models/Patient.js';
import Doctor from '../models/Doctor.js';
import { findDoctorByName } from '../utils/doctorHelper.js';
import { mapAppointmentDTO } from '../utils/appointmentDto.js';

const router = express.Router();

// ======================================================
// 🔒 IDEMPOTENCY HELPERS
// ======================================================
function getRequestId(req) {
    return req.headers['x-client-request-id'] || req.headers['x-idempotency-key'] || null;
}

async function assertIdempotency(requestId, res) {
    if (!requestId) return true;
    const alreadyProcessed = await eventExists(`req_${requestId}`);
    if (alreadyProcessed) {
        res.status(200).json({
            success: true,
            skipped: true,
            reason: 'idempotent_request',
            message: 'Requisição já processada anteriormente'
        });
        return false;
    }
    return true;
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
        const { limit = 50, status, phone, from, to, doctorId, specialty } = req.query;

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

        const preAppointments = await Appointment.find(query)
            .populate('doctor', 'fullName specialty')
            .populate('patient', 'fullName phone dateOfBirth email')
            .sort({ createdAt: -1 })
            .limit(parseInt(limit))
            .lean();

        res.json({
            success: true,
            data: preAppointments.map(mapAppointmentDTO),
            count: preAppointments.length
        });

    } catch (error) {
        console.error('[PreAppointmentEngine] Erro ao listar:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao listar pré-agendamentos: ' + error.message
        });
    }
});

// ======================================================
// GET /api/v2/pre-appointments/:id - Detalhes
// ======================================================
router.get('/:id', flexibleAuth, async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, error: 'ID inválido' });
        }

        const pre = await Appointment.findById(id)
            .populate('doctor', 'fullName specialty')
            .populate('patient', 'fullName phone dateOfBirth email')
            .lean();

        if (!pre || pre.operationalStatus !== 'pre_agendado') {
            return res.status(404).json({ success: false, error: 'Pré-agendamento não encontrado' });
        }

        res.json({ success: true, data: mapAppointmentDTO(pre) });

    } catch (error) {
        console.error('[PreAppointmentEngine] Erro ao buscar:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ======================================================
// POST /api/v2/pre-appointments - Cria pré-agendamento
// ======================================================
router.post('/', flexibleAuth, async (req, res) => {
    try {
        const requestId = getRequestId(req);
        if (!(await assertIdempotency(requestId, res))) return;

        const {
            patientInfo,
            date,
            time,
            preferredDate,
            preferredTime,
            specialty,
            notes,
            patientId,
            professionalName,
            doctorId,
            source
        } = req.body;

        const effectiveDate = date || preferredDate;
        const effectiveTime = time || preferredTime;

        if (!patientInfo?.fullName || !effectiveDate) {
            return res.status(400).json({
                success: false,
                error: 'Nome do paciente e data preferida são obrigatórios'
            });
        }

        // Resolve doutor se informado
        let doctor = null;
        if (doctorId && mongoose.Types.ObjectId.isValid(doctorId)) {
            doctor = await Doctor.findById(doctorId);
        }
        if (!doctor && professionalName) {
            doctor = await findDoctorByName(professionalName).catch(() => null);
        }

        const preAppointment = new Appointment({
            patient: patientId || undefined,
            patientInfo: {
                fullName: patientInfo.fullName,
                phone: (patientInfo.phone || '').replace(/\D/g, ''),
                birthDate: patientInfo.birthDate || null,
                email: patientInfo.email || null
            },
            date: new Date(`${effectiveDate}T00:00:00-03:00`),
            time: effectiveTime,
            specialty: (specialty || doctor?.specialty || 'fonoaudiologia').toLowerCase(),
            notes,
            doctor: doctor?._id || undefined,
            professionalName: doctor?.fullName || professionalName || '',
            operationalStatus: 'pre_agendado',
            clinicalStatus: 'pending',
            paymentStatus: 'pending',
            metadata: source ? { origin: { source } } : undefined,
            createdBy: req.user?._id?.toString(),
            createdAt: new Date()
        });

        await preAppointment.save();
        await markIdempotency(requestId);

        // Emite evento para notificações em tempo real
        await publishEvent(
            EventTypes.PREAGENDAMENTO_CREATED,
            {
                preAppointmentId: preAppointment._id.toString(),
                patientName: patientInfo.fullName,
                specialty: preAppointment.specialty,
                source: 'preappointment_engine_v2'
            },
            { correlationId: `pre_${preAppointment._id}` }
        ).catch(() => {});

        res.status(201).json({
            success: true,
            message: 'Pré-agendamento criado com sucesso',
            data: {
                preAppointmentId: preAppointment._id,
                appointmentId: preAppointment._id, // compatibilidade
                operationalStatus: 'pre_agendado',
                status: 'novo'
            }
        });

    } catch (error) {
        console.error('[PreAppointmentEngine] Erro ao criar:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao criar pré-agendamento: ' + error.message
        });
    }
});

// ======================================================
// POST /api/v2/pre-appointments/:id/confirm - CONFIRMA
// ======================================================
router.post('/:id/confirm', flexibleAuth, async (req, res) => {
    const mongoSession = await mongoose.startSession();
    mongoSession.startTransaction();

    try {
        const requestId = getRequestId(req);
        if (requestId) {
            const alreadyProcessed = await eventExists(`req_${requestId}`);
            if (alreadyProcessed) {
                await mongoSession.abortTransaction();
                return res.status(200).json({
                    success: true,
                    skipped: true,
                    reason: 'idempotent_request'
                });
            }
        }

        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            await mongoSession.abortTransaction();
            return res.status(400).json({ success: false, error: 'ID inválido' });
        }

        const { doctorId, professionalId, date, time, notes, sessionValue = 0 } = req.body;

        // Normaliza entrada: doctorId é canônico, professionalId é alias legado
        let resolvedDoctorId = doctorId;
        if (!resolvedDoctorId && professionalId) {
            console.warn('[PreAppointmentEngine] professionalId recebido — usando como alias de doctorId');
            resolvedDoctorId = professionalId;
        }

        // Busca pré-agendamento
        const pre = await Appointment.findById(id).session(mongoSession);
        if (!pre || pre.operationalStatus !== 'pre_agendado') {
            await mongoSession.abortTransaction();
            return res.status(404).json({ success: false, error: 'Pré-agendamento não encontrado' });
        }

        // Idempotência: já foi confirmado?
        if (pre.operationalStatus !== 'pre_agendado' && pre.appointmentId) {
            await mongoSession.abortTransaction();
            return res.status(200).json({
                success: true,
                skipped: true,
                reason: 'already_confirmed',
                appointmentId: pre.appointmentId
            });
        }

        // Resolve doutor (fallback para dados do pré-agendamento)
        if (!resolvedDoctorId && pre.doctor) {
            resolvedDoctorId = pre.doctor.toString();
        }
        if (!resolvedDoctorId && pre.professionalName) {
            const doc = await findDoctorByName(pre.professionalName).catch(() => null);
            if (doc) resolvedDoctorId = doc._id.toString();
        }
        if (!resolvedDoctorId) {
            await mongoSession.abortTransaction();
            return res.status(400).json({ success: false, error: 'Profissional não encontrado' });
        }

        // Resolve paciente (busca por telefone ou cria novo)
        let patientId = pre.patient;
        if (!patientId && pre.patientInfo?.phone) {
            const cleanPhone = pre.patientInfo.phone.replace(/\D/g, '');
            const existingPatient = await Patient.findOne({
                phone: { $regex: cleanPhone.slice(-10) }
            }).session(mongoSession).lean();
            if (existingPatient) {
                patientId = existingPatient._id.toString();
            }
        }
        if (!patientId && pre.patientInfo?.fullName) {
            const newPatient = new Patient({
                fullName: pre.patientInfo.fullName,
                phone: pre.patientInfo.phone || '',
                dateOfBirth: pre.patientInfo.birthDate ? new Date(pre.patientInfo.birthDate) : new Date('2000-01-01'),
                email: pre.patientInfo.email || null,
                source: 'agenda_externa_v2'
            });
            await newPatient.save({ session: mongoSession });
            patientId = newPatient._id.toString();
        }
        if (!patientId) {
            await mongoSession.abortTransaction();
            return res.status(400).json({ success: false, error: 'Não foi possível criar/encontrar o paciente' });
        }

        // Resolve data: body tem prioridade, fallback para o pre-agendamento
        const resolvedDateStr = date || (pre.date instanceof Date
            ? pre.date.toISOString().split('T')[0]
            : String(pre.date || '').split('T')[0]);

        // Chama o CRM Core V2 (HYBRID SERVICE)
        const hybridResult = await appointmentHybridService.create({
            patientId,
            doctorId: resolvedDoctorId,
            date: new Date(resolvedDateStr + 'T12:00:00-03:00'),
            time,
            specialty: pre.specialty || 'fonoaudiologia',
            serviceType: 'evaluation', // Agenda externa sempre começa como avaliação
            billingType: 'particular',
            paymentMethod: req.body.paymentMethod || 'pix',
            amount: Number(sessionValue),
            notes: notes || pre.notes || '',
            userId: req.user?._id?.toString()
        }, mongoSession);

        // Atualiza o operationalStatus do appointment criado para scheduled
        const createdAppointment = await Appointment.findById(hybridResult.appointmentId).session(mongoSession);
        if (createdAppointment) {
            createdAppointment.operationalStatus = 'scheduled';
            // Popula patientInfo do pré-agendamento (hybrid service não persiste esse campo)
            if (!createdAppointment.patientInfo?.fullName && pre.patientInfo?.fullName) {
                createdAppointment.patientInfo = {
                    fullName: pre.patientInfo.fullName,
                    phone: pre.patientInfo.phone || '',
                    birthDate: pre.patientInfo.birthDate || null,
                    email: pre.patientInfo.email || null,
                };
            }
            await createdAppointment.save({ session: mongoSession });
        }

        // Atualiza pré-agendamento original
        if (!hybridResult.appointmentId) {
            await mongoSession.abortTransaction();
            return res.status(500).json({ success: false, error: 'Falha ao criar agendamento: appointmentId não retornado' });
        }
        pre.operationalStatus = 'converted';
        pre.doctor = null; // libera o slot para o appointment real
        pre.appointmentId = hybridResult.appointmentId;
        pre.importedAt = new Date();
        pre.importedBy = req.user?._id?.toString();
        await pre.save({ session: mongoSession });

        await mongoSession.commitTransaction();
        await markIdempotency(requestId);

        // Evento pós-confirmação
        await publishEvent(
            EventTypes.PREAGENDAMENTO_IMPORTED,
            {
                preAppointmentId: pre._id.toString(),
                appointmentId: hybridResult.appointmentId,
                patientId,
                doctorId: resolvedDoctorId,
                source: 'preappointment_engine_v2'
            },
            { correlationId: `import_${hybridResult.appointmentId}` }
        ).catch(() => {});

        res.json({
            success: true,
            message: 'Agendamento confirmado com sucesso',
            data: {
                appointmentId: hybridResult.appointmentId,
                sessionId: hybridResult.sessionId || null,
                paymentId: hybridResult.paymentId || null,
                patientId
            }
        });

    } catch (error) {
        await mongoSession.abortTransaction().catch(() => {});
        console.error('[PreAppointmentEngine] Erro ao confirmar:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao confirmar pré-agendamento: ' + error.message
        });
    } finally {
        mongoSession.endSession();
    }
});

// ======================================================
// PATCH /api/v2/pre-appointments/:id - Atualiza pré-agendamento
// ======================================================
router.patch('/:id', flexibleAuth, async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, error: 'ID inválido' });
        }

        const updates = req.body;
        // Mapear campos do formato antigo para o novo
        if (updates.preferredDate) { updates.date = updates.preferredDate; delete updates.preferredDate; }
        if (updates.preferredTime) { updates.time = updates.preferredTime; delete updates.preferredTime; }
        if (updates.status) { updates.operationalStatus = updates.status; delete updates.status; }
        if (updates.suggestedValue !== undefined) { updates.sessionValue = updates.suggestedValue; delete updates.suggestedValue; }

        await Appointment.findByIdAndUpdate(
            id,
            { ...updates, updatedAt: new Date() },
            { new: true, runValidators: false }
        );

        const pre = await Appointment.findById(id)
            .populate('patient', 'fullName phone dateOfBirth email')
            .populate('doctor', 'fullName specialty')
            .lean();

        if (!pre) {
            return res.status(404).json({ success: false, error: 'Pré-agendamento não encontrado' });
        }

        res.json({ success: true, data: mapAppointmentDTO(pre) });
    } catch (error) {
        console.error('[PreAppointmentEngine] Erro ao atualizar:', error);
        res.status(500).json({ success: false, error: 'Erro ao atualizar pré-agendamento: ' + error.message });
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
        const pre = await Appointment.findByIdAndUpdate(
            id,
            {
                operationalStatus: 'canceled',
                discardReason: reason,
                discardedAt: new Date(),
                discardedBy: req.user?._id?.toString()
            },
            { new: true }
        );

        if (!pre) {
            return res.status(404).json({ success: false, error: 'Pré-agendamento não encontrado' });
        }

        res.json({ success: true, message: 'Descartado com sucesso', data: pre });
    } catch (error) {
        console.error('[PreAppointmentEngine] Erro ao descartar:', error);
        res.status(500).json({ success: false, error: 'Erro ao descartar pré-agendamento: ' + error.message });
    }
});

// ======================================================
// POST /api/v2/pre-appointments/:id/cancel - Cancela pré-agendamento
// ======================================================
router.post('/:id/cancel', flexibleAuth, async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, error: 'ID inválido' });
        }

        const pre = await Appointment.findByIdAndUpdate(
            id,
            { operationalStatus: 'canceled' },
            { new: true }
        );

        if (!pre) {
            return res.status(404).json({ success: false, error: 'Pré-agendamento não encontrado' });
        }

        res.json({ success: true, message: 'Pré-agendamento cancelado' });
    } catch (error) {
        console.error('[PreAppointmentEngine] Erro ao cancelar:', error);
        res.status(500).json({ success: false, error: 'Erro ao cancelar pré-agendamento: ' + error.message });
    }
});

export default router;
