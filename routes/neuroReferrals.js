// routes/neuroReferrals.js
// Candidatos a neuro (/api/neuro-referrals): paciente da casa com sinais de TEA/TDAH → consulta com
// neuropediatra para o laudo (só particular). Terapeuta indica/confirma; recepção oferece e registra.
import express from 'express';
import mongoose from 'mongoose';
import {
    NEURO_REFERRAL_ACTIVE_STATUS,
    NEURO_REFERRAL_REASONS,
    NEURO_REFERRAL_STATUS,
} from '../constants/neuroReferral.js';
import { auth, authorize } from '../middleware/auth.js';
import validateId from '../middleware/validateId.js';
import NeuroReferral from '../models/NeuroReferral.js';
import {
    applyStatus,
    canTransition,
    patientIdsOfDoctor,
    reconcileScheduled,
    scanSuggestions,
} from '../services/neuroReferralService.js';
import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';

const LOG = '[NEURO-REFERRAL]';
const badRequest = (message) => new AppError('BAD_REQUEST', message, { status: 400 });
const actorOf = (req) => ({ id: mongoose.Types.ObjectId.isValid(req.user?.id) ? req.user.id : null, role: req.user?.role });
const cleanText = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const cleanReasons = (v) => (Array.isArray(v) ? [...new Set(v.filter(r => NEURO_REFERRAL_REASONS.includes(r)))] : []);

const PATIENT_FIELDS = 'fullName dateOfBirth phone legalGuardian status';

export const createNeuroReferralsRouter = () => {
    const router = express.Router();
    router.use(auth);

    // Resumo para o painel: quantos em cada status + conversão
    router.get('/summary', authorize(['admin', 'secretary']), async (req, res) => {
        try {
            await reconcileScheduled();
            const rows = await NeuroReferral.aggregate([{ $group: { _id: '$status', total: { $sum: 1 } } }]);
            const byStatus = Object.fromEntries(NEURO_REFERRAL_STATUS.map(s => [s, 0]));
            rows.forEach(r => { byStatus[r._id] = r.total; });
            const offeredOrMore = byStatus.oferecido + byStatus.agendado + byStatus.recusado;
            res.json({
                success: true,
                data: {
                    byStatus,
                    pendingOffer: byStatus.indicado,
                    pendingTherapist: byStatus.a_confirmar,
                    conversionRate: offeredOrMore ? Number((byStatus.agendado / offeredOrMore).toFixed(3)) : null,
                },
            });
        } catch (err) {
            console.error(`${LOG} summary`, err);
            sendApiError(res, err, req);
        }
    });

    // Lista. Terapeuta vê só os pacientes que atende.
    router.get('/', authorize(['admin', 'secretary', 'doctor']), async (req, res) => {
        try {
            await reconcileScheduled();
            const filter = {};
            const statuses = String(req.query.status || '').split(',').filter(s => NEURO_REFERRAL_STATUS.includes(s));
            if (statuses.length) filter.status = { $in: statuses };
            else if (req.query.status !== 'all') filter.status = { $in: NEURO_REFERRAL_ACTIVE_STATUS };
            if (req.user.role === 'doctor') filter.patient = { $in: await patientIdsOfDoctor(req.user.id) };
            if (req.query.patientId) {
                if (!mongoose.Types.ObjectId.isValid(req.query.patientId)) throw badRequest('patientId inválido');
                const pid = String(req.query.patientId);
                const allowed = !filter.patient || filter.patient.$in.some(id => String(id) === pid);
                filter.patient = allowed ? new mongoose.Types.ObjectId(pid) : { $in: [] };
            }

            const limit = Math.min(Number(req.query.limit) || 200, 500);
            const items = await NeuroReferral.find(filter)
                .sort({ updatedAt: -1 })
                .limit(limit)
                .populate('patient', PATIENT_FIELDS)
                .lean();
            res.json({ success: true, data: items });
        } catch (err) {
            console.error(`${LOG} list`, err);
            sendApiError(res, err, req);
        }
    });

    // Indicação do paciente (pela ficha). Idempotente: se já existe ativo, confirma/atualiza em vez de duplicar.
    router.post('/', authorize(['admin', 'doctor', 'secretary']), async (req, res) => {
        try {
            const { patientId } = req.body || {};
            if (!mongoose.Types.ObjectId.isValid(patientId)) throw badRequest('patientId inválido');
            const reasons = cleanReasons(req.body.reasons);
            const note = cleanText(req.body.note, 1000);
            const actor = actorOf(req);
            // Recepção registra a pedido da terapeuta; terapeuta/admin indicam direto
            const Patient = mongoose.models.Patient;
            if (Patient && !(await Patient.exists({ _id: patientId }))) {
                throw new AppError('NOT_FOUND', 'Paciente não encontrado', { status: 404 });
            }

            let doc = await NeuroReferral.findOne({ patient: patientId, status: { $in: NEURO_REFERRAL_ACTIVE_STATUS } });
            if (doc) {
                if (reasons.length) doc.reasons = [...new Set([...doc.reasons, ...reasons])];
                if (note) doc.note = note;
                if (doc.status === 'a_confirmar') applyStatus(doc, 'indicado', actor, note || 'Indicação confirmada');
                await doc.save();
                return res.json({ success: true, data: doc, created: false });
            }

            doc = new NeuroReferral({
                patient: patientId,
                source: 'terapeuta',
                reasons,
                note,
                requestedBy: actor,
                history: [],
            });
            applyStatus(doc, 'indicado', actor, note);
            try {
                await doc.save();
            } catch (err) {
                if (err?.code !== 11000) throw err;
                doc = await NeuroReferral.findOne({ patient: patientId, status: { $in: NEURO_REFERRAL_ACTIVE_STATUS } });
                return res.json({ success: true, data: doc, created: false });
            }
            console.log(`${LOG} indicação criada paciente=${patientId} por ${actor.role}`);
            res.status(201).json({ success: true, data: doc, created: true });
        } catch (err) {
            sendApiError(res, err, req);
        }
    });

    // Varredura de sugestões automáticas. ?dryRun=1 só conta (não grava).
    router.post('/scan', authorize(['admin', 'secretary']), async (req, res) => {
        try {
            const dryRun = ['1', 'true'].includes(String(req.query.dryRun || req.body?.dryRun || ''));
            const result = await scanSuggestions({ dryRun, actor: actorOf(req) });
            res.json({ success: true, data: { ...result, dryRun } });
        } catch (err) {
            console.error(`${LOG} scan`, err);
            sendApiError(res, err, req);
        }
    });

    // Mudança de status (terapeuta confirma/descarta; recepção oferece/registra resultado)
    router.patch('/:id', authorize(['admin', 'secretary', 'doctor']), validateId, async (req, res) => {
        try {
            const { status } = req.body || {};
            const note = cleanText(req.body?.note, 1000);
            const doc = await NeuroReferral.findById(req.params.id);
            if (!doc) throw new AppError('NOT_FOUND', 'Indicação não encontrada', { status: 404 });

            if (req.user.role === 'doctor') {
                const mine = await patientIdsOfDoctor(req.user.id);
                if (!mine.some(id => String(id) === String(doc.patient))) {
                    throw new AppError('FORBIDDEN', 'Paciente não é atendido por você', { status: 403 });
                }
            }

            if (status !== undefined) {
                if (!NEURO_REFERRAL_STATUS.includes(status)) throw badRequest('Status inválido');
                if (!canTransition(req.user.role, doc.status, status)) {
                    throw new AppError('INVALID_TRANSITION', `Não é possível ir de "${doc.status}" para "${status}"`, { status: 409 });
                }
                const reasons = cleanReasons(req.body?.reasons);
                if (reasons.length) doc.reasons = reasons;
                applyStatus(doc, status, actorOf(req), note, { declineReason: cleanText(req.body?.declineReason, 500) });
            } else if (note) {
                doc.note = note;
            } else {
                throw badRequest('Nada para atualizar');
            }

            try {
                await doc.save();
            } catch (err) {
                // reabrir (recusado → indicado) com outro ativo já existente para o paciente
                if (err?.code === 11000) throw new AppError('CONFLICT', 'Já existe uma indicação ativa para este paciente', { status: 409 });
                throw err;
            }
            console.log(`${LOG} ${doc._id} → ${doc.status} por ${req.user.role}`);
            res.json({ success: true, data: doc });
        } catch (err) {
            sendApiError(res, err, req);
        }
    });

    return router;
};

export default createNeuroReferralsRouter();
