/**
 * 🧬 Evolution Routes — V2 (Clinical-First)
 *
 * Princípio: Tudo que impacta atendimento = síncrono.
 *
 * - Writes (POST/PUT/DELETE): salvam direto no MongoDB, retornam documento populado.
 *   Eventos são publicados DEPOIS do sucesso para side-effects (analytics, notificações).
 * - Reads: diretos no MongoDB com escopo de profissional (doctor) para não-admins.
 */

import express from 'express';
import mongoose from 'mongoose';
import Evolution, { FINALIZED_FILTER } from '../models/Evolution.js';
import Metric from '../models/Metric.js';
import Appointment from '../models/Appointment.js';
import Patient from '../models/Patient.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import { flexibleAuth } from '../middleware/amandaAuth.js';
import { generatePdfFromEvolution } from '../services/generatePDF.js';

const router = express.Router();

// ─── Helpers ──────────────────────────────────────────────────────────

const isAdmin = (user) => ['admin', 'superadmin'].includes(String(user?.role || '').toLowerCase());

const getEvolutionScope = (req) => {
    if (isAdmin(req.user)) return {};
    return { doctor: new mongoose.Types.ObjectId(req.user.id) };
};

// Escopo para leitura de evoluções DE UM PACIENTE — visibilidade compartilhada
// entre profissionais da clínica para coordenação de cuidado
const getPatientReadScope = (_req) => ({});

const success = (data, meta = {}) => ({
    success: true,
    data,
    meta: { version: 'v2', timestamp: new Date().toISOString(), ...meta }
});

const failure = (code, message, details) => ({
    success: false,
    error: { code, message, details },
    meta: { version: 'v2', timestamp: new Date().toISOString() }
});

// ─── RASCUNHO (autosave) ──────────────────────────────────────────────
// Fase 1 da sprint prontuário (03/11/2026). Um rascunho por agendamento
// (índice único unique_evolution_per_appointment). Rascunho nunca entra em
// gráfico, indicador, pendência resolvida nem relatório (FINALIZED_FILTER).
// Só POST /:id/finalize (ou o POST / legado) transforma em evolução válida.

// Campos clínicos que o rascunho aceita. Nada de patient/doctor/status vindo do cliente.
const DRAFT_FIELDS = [
    'time', 'specialty', 'content', 'observations', 'metrics', 'evaluationAreas',
    'evaluationTypes', 'plan', 'treatmentStatus', 'therapeuticPlan'
];

const pickDraftFields = (body = {}) => {
    const out = {};
    for (const k of DRAFT_FIELDS) {
        if (body[k] !== undefined) out[k] = body[k];
    }
    if (typeof out.specialty === 'string') out.specialty = out.specialty.trim();
    if (body.protocolCode !== undefined) out.activeProtocols = body.protocolCode ? [body.protocolCode] : [];
    return out;
};

// Mesma regra do POST /: date + time em UTC para manter a unicidade por horário.
const sessionDate = (date, time) => {
    const d = new Date(date);
    if (time) {
        const [h, m] = String(time).split(':').map(Number);
        if (Number.isFinite(h) && Number.isFinite(m)) d.setUTCHours(h, m, 0, 0);
    }
    return d;
};

const hasClinicalContent = (evo) => {
    const text = typeof evo.content === 'string' ? evo.content.trim() : (evo.content ? JSON.stringify(evo.content) : '');
    const obs = String(evo.observations || '').trim();
    const areas = (evo.evaluationAreas || []).some(a => a && a.score !== undefined && a.score !== null);
    const metrics = (evo.metrics || []).some(m => m && m.value !== undefined && m.value !== null);
    return Boolean(text || obs || areas || metrics);
};

router.put('/draft', flexibleAuth, async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json(failure('UNAUTHORIZED', 'Usuário não autenticado'));

        const { appointmentId, baseAutosaveAt } = req.body || {};
        if (!appointmentId || !mongoose.Types.ObjectId.isValid(appointmentId)) {
            return res.status(400).json(failure('INVALID_APPOINTMENT', 'Rascunho precisa do agendamento'));
        }

        const appt = await Appointment.findById(appointmentId).select('patient doctor date time specialty').lean();
        if (!appt) return res.status(404).json(failure('APPOINTMENT_NOT_FOUND', 'Agendamento não encontrado'));
        if (!appt.patient) return res.status(400).json(failure('APPOINTMENT_WITHOUT_PATIENT', 'Agendamento sem paciente'));
        if (!isAdmin(req.user) && String(appt.doctor) !== String(userId)) {
            return res.status(403).json(failure('FORBIDDEN', 'Esse atendimento é de outro profissional'));
        }

        const fields = pickDraftFields(req.body);
        const specialty = fields.specialty || appt.specialty || req.user?.specialty;
        if (!specialty) return res.status(400).json(failure('MISSING_SPECIALTY', 'Especialidade é obrigatória'));
        fields.specialty = specialty;

        const now = new Date();
        const doctorId = appt.doctor || userId;
        const filter = { appointmentId, status: 'draft' };
        if (!isAdmin(req.user)) filter.doctor = doctorId;
        // Outro aparelho salvou depois da versão que este cliente tem: não sobrescreve.
        if (baseAutosaveAt) filter.lastAutosaveAt = { $lte: new Date(baseAutosaveAt) };

        const insertOnly = {
            patient: appt.patient,
            doctor: doctorId,
            createdBy: userId,
            appointmentId,
            status: 'draft',
            date: sessionDate(appt.date, fields.time || appt.time)
        };

        let draft;
        try {
            draft = await Evolution.findOneAndUpdate(
                filter,
                { $set: { ...fields, lastAutosaveAt: now }, $setOnInsert: insertOnly },
                { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
            ).lean();
        } catch (err) {
            if (err?.code !== 11000) throw err;
            // Já existe evolução nesse agendamento que o filtro não pegou: decide o motivo.
            const existing = await Evolution.findOne({ appointmentId }).select('status doctor lastAutosaveAt').lean();
            if (!existing) throw err;
            if (existing.status !== 'draft') {
                return res.status(409).json(failure('EVOLUTION_ALREADY_FINALIZED', 'Essa evolução já foi finalizada', { evolutionId: existing._id }));
            }
            if (!isAdmin(req.user) && String(existing.doctor) !== String(doctorId)) {
                return res.status(403).json(failure('FORBIDDEN', 'Rascunho de outro profissional'));
            }
            return res.status(409).json(failure('DRAFT_CONFLICT', 'Rascunho salvo em outro aparelho mais recentemente', {
                evolutionId: existing._id, lastAutosaveAt: existing.lastAutosaveAt
            }));
        }

        res.json(success(draft, { lastAutosaveAt: draft.lastAutosaveAt }));
    } catch (error) {
        console.error('[EvolutionV2] Erro ao salvar rascunho:', error.message);
        if (error.name === 'ValidationError') {
            const errors = Object.values(error.errors).map(e => e.message);
            return res.status(400).json(failure('VALIDATION_ERROR', 'Erro de validação', errors));
        }
        res.status(500).json(failure('INTERNAL_ERROR', error.message));
    }
});

// Rascunhos do profissional logado (admin pode passar ?doctorId=)
router.get('/drafts', flexibleAuth, async (req, res) => {
    try {
        const doctorIdRaw = isAdmin(req.user) && req.query.doctorId ? req.query.doctorId : req.user?.id;
        if (!doctorIdRaw || !mongoose.Types.ObjectId.isValid(doctorIdRaw)) {
            return res.status(400).json(failure('INVALID_DOCTOR', 'Profissional inválido'));
        }
        const drafts = await Evolution.find({ doctor: doctorIdRaw, status: 'draft' })
            .select('patient appointmentId date time specialty lastAutosaveAt evaluationAreas content')
            .populate('patient', 'fullName')
            .sort({ lastAutosaveAt: -1 })
            .limit(200)
            .lean();
        res.json(success(drafts, { count: drafts.length }));
    } catch (error) {
        console.error('[EvolutionV2] Erro ao listar rascunhos:', error.message);
        res.status(500).json(failure('INTERNAL_ERROR', error.message));
    }
});

// Evolução (rascunho ou finalizada) de um agendamento, para reabrir o modal
router.get('/appointment/:appointmentId', flexibleAuth, async (req, res) => {
    try {
        const { appointmentId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(appointmentId)) {
            return res.status(400).json(failure('INVALID_ID', 'ID inválido'));
        }
        const raw = await Evolution.findOne({ appointmentId }).select('doctor status').lean();
        if (!raw) return res.json(success(null));
        const isOwner = String(raw.doctor) === String(req.user?.id);
        // Rascunho é só do dono (ou admin). Finalizada segue a visibilidade compartilhada.
        if (raw.status === 'draft' && !isOwner && !isAdmin(req.user)) return res.json(success(null));
        const evo = await Evolution.findById(raw._id)
            .populate('doctor', 'fullName specialty')
            .populate('patient', 'fullName dateOfBirth')
            .lean();
        res.json(success(evo));
    } catch (error) {
        console.error('[EvolutionV2] Erro ao buscar por agendamento:', error.message);
        res.status(500).json(failure('INTERNAL_ERROR', error.message));
    }
});

// Finaliza um rascunho já carregado. Retorna { status, body } para a rota responder.
async function finalizeDraftDoc(evolution, body, user) {
    const id = evolution._id.toString();
    const isOwner = evolution.doctor?.toString() === String(user?.id);
    if (!isAdmin(user) && !isOwner) {
        return { status: 403, body: failure('FORBIDDEN', 'Sem permissão para finalizar') };
    }
    // Idempotente: clique duplo ou retry não quebra nem publica evento de novo.
    if (evolution.status !== 'draft') {
        return { status: 200, body: success(evolution, { alreadyFinalized: true }) };
    }

    Object.assign(evolution, pickDraftFields(body));
    if (!evolution.specialty) return { status: 400, body: failure('MISSING_SPECIALTY', 'Especialidade é obrigatória') };
    if (!hasClinicalContent(evolution)) {
        return { status: 400, body: failure('EMPTY_EVOLUTION', 'Escreva o que aconteceu na sessão ou preencha ao menos uma área') };
    }
    if (evolution.therapeuticPlan?.objectives) evolution.calculateObjectivesProgress();
    if (evolution.therapeuticPlan?.protocol?.code) evolution.activeProtocols = [evolution.therapeuticPlan.protocol.code];
    evolution.status = 'finalized';
    evolution.finalizedAt = new Date();
    await evolution.validate();

    // Transição atômica: só um request vira o rascunho em finalizada.
    const update = evolution.toObject({ depopulate: true });
    delete update._id; delete update.__v; delete update.createdAt; delete update.updatedAt;
    const finalized = await Evolution.findOneAndUpdate({ _id: id, status: 'draft' }, { $set: update }, { new: true });
    if (!finalized) {
        const current = await Evolution.findById(id);
        return { status: 200, body: success(current, { alreadyFinalized: true }) };
    }

    const populated = await Evolution.findById(id)
        .populate('doctor', 'fullName specialty')
        .populate('patient', 'fullName dateOfBirth');

    // Mesmo evento do POST /: para os side-effects, a evolução "nasce" agora.
    try {
        await publishEvent(EventTypes.EVOLUTION_CREATED, {
            evolutionId: id,
            patientId: finalized.patient?.toString?.(),
            doctorId: finalized.doctor?.toString?.(),
            appointmentId: finalized.appointmentId?.toString?.(),
            date: finalized.date,
        }, { correlationId: `evo_create_${id}` });
    } catch (evtErr) {
        console.warn('[EvolutionV2] Evento de side-effect falhou (não crítico):', evtErr.message);
    }

    return { status: 200, body: success(populated) };
}

const sendValidationOr500 = (res, error) => {
    if (error.name === 'ValidationError') {
        const errors = Object.values(error.errors).map(e => e.message);
        return res.status(400).json(failure('VALIDATION_ERROR', 'Erro de validação', errors));
    }
    return res.status(500).json(failure('INTERNAL_ERROR', error.message));
};

router.post('/:id/finalize', flexibleAuth, async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json(failure('INVALID_ID', 'ID inválido'));
        }
        const evolution = await Evolution.findById(id);
        if (!evolution) return res.status(404).json(failure('NOT_FOUND', 'Evolução não encontrada'));
        const out = await finalizeDraftDoc(evolution, req.body, req.user);
        res.status(out.status).json(out.body);
    } catch (error) {
        console.error('[EvolutionV2] Erro ao finalizar:', error.message);
        sendValidationOr500(res, error);
    }
});

// ─── WRITES (síncronos — feedback imediato ao profissional) ───────────

router.post('/', flexibleAuth, async (req, res) => {
    try {
        const payload = req.body;
        const doctorId = req.user?.id;

        // 🛡️ Validação de campos obrigatórios
        if (!payload.patient || !mongoose.Types.ObjectId.isValid(payload.patient)) {
            return res.status(400).json(failure('INVALID_PATIENT', 'Paciente inválido'));
        }
        if (!payload.date) {
            return res.status(400).json(failure('MISSING_DATE', 'Data é obrigatória'));
        }
        if (!payload.specialty?.trim()) {
            return res.status(400).json(failure('MISSING_SPECIALTY', 'Especialidade é obrigatória'));
        }
        if (!doctorId) {
            return res.status(401).json(failure('UNAUTHORIZED', 'Usuário não autenticado'));
        }
        // Combina date + time para garantir unicidade por horário (permite múltiplas sessões no mesmo dia)
        const dateObj = new Date(payload.date);
        if (payload.time) {
            const [h, m] = String(payload.time).split(':').map(Number);
            dateObj.setUTCHours(h, m, 0, 0);
        } else {
            dateObj.setUTCMilliseconds(Date.now() % 1000);
        }

        // Já existe rascunho desse agendamento? O "Salvar" antigo vira finalizar.
        if (payload.appointmentId && mongoose.Types.ObjectId.isValid(payload.appointmentId)) {
            const draft = await Evolution.findOne({ appointmentId: payload.appointmentId, status: 'draft' });
            if (draft) {
                const out = await finalizeDraftDoc(draft, payload, req.user);
                return res.status(out.status === 200 ? 201 : out.status).json(out.body);
            }
        }

        const doc = new Evolution({
            status: 'finalized',
            finalizedAt: new Date(),
            patient: payload.patient,
            doctor: doctorId,
            date: dateObj,
            time: payload.time,
            specialty: payload.specialty.trim(),
            content: payload.content || '',
            observations: payload.observations || '',
            metrics: payload.metrics || [],
            evaluationAreas: payload.evaluationAreas || [],
            evaluationTypes: payload.evaluationTypes || [],
            plan: payload.plan || '',
            treatmentStatus: payload.treatmentStatus || 'in_progress',
            therapeuticPlan: payload.therapeuticPlan || null,
            protocolCode: payload.protocolCode || null,
            activeProtocols: payload.protocolCode ? [payload.protocolCode] : [],
            appointmentId: payload.appointmentId || undefined,
            createdBy: doctorId,
        });

        // Calcula progresso dos objetivos se houver plano terapêutico
        if (doc.therapeuticPlan?.objectives) {
            doc.calculateObjectivesProgress();
        }

        await doc.save();

        const populated = await Evolution.findById(doc._id)
            .populate('doctor', 'fullName specialty')
            .populate('patient', 'fullName dateOfBirth');

        // 🔔 Publica evento para side-effects (analytics, notificações, etc.)
        try {
            await publishEvent(EventTypes.EVOLUTION_CREATED, {
                evolutionId: doc._id.toString(),
                patientId: payload.patient,
                doctorId,
                appointmentId: payload.appointmentId,
                date: payload.date,
            }, { correlationId: `evo_create_${doc._id}` });
        } catch (evtErr) {
            console.warn('[EvolutionV2] Evento de side-effect falhou (não crítico):', evtErr.message);
        }

        res.status(201).json(success(populated));
    } catch (error) {
        console.error('[EvolutionV2] Erro ao criar:', error);

        if (error.name === 'ValidationError') {
            const errors = Object.values(error.errors).map(e => e.message);
            return res.status(400).json(failure('VALIDATION_ERROR', 'Erro de validação', errors));
        }
        if (error.code === 11000) {
            return res.status(409).json(failure('DUPLICATE_EVOLUTION', 'Já existe uma evolução com esses dados'));
        }

        res.status(500).json(failure('INTERNAL_ERROR', error.message));
    }
});

router.put('/:id', flexibleAuth, async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json(failure('INVALID_ID', 'ID inválido'));
        }

        const evolution = await Evolution.findById(id);
        if (!evolution) {
            return res.status(404).json(failure('NOT_FOUND', 'Evolução não encontrada'));
        }

        // Verifica permissão
        const isOwner = evolution.doctor?.toString() === req.user?.id;
        if (!isAdmin(req.user) && !isOwner) {
            return res.status(403).json(failure('FORBIDDEN', 'Sem permissão para editar'));
        }

        const previousData = evolution.toObject();
        // status/finalizedAt só mudam por POST /:id/finalize.
        const { status: _s, finalizedAt: _f, lastAutosaveAt: _l, ...editable } = req.body || {};
        Object.assign(evolution, editable);

        if (evolution.therapeuticPlan?.objectives) {
            evolution.calculateObjectivesProgress();
        }

        await evolution.save();

        const populated = await Evolution.findById(evolution._id)
            .populate('doctor', 'fullName specialty')
            .populate('patient', 'fullName dateOfBirth');

        // Side-effect event
        try {
            await publishEvent(EventTypes.EVOLUTION_UPDATED, {
                evolutionId: id,
                patientId: evolution.patient?.toString?.(),
                doctorId: evolution.doctor?.toString?.(),
            }, { correlationId: `evo_update_${id}` });
        } catch (evtErr) {
            console.warn('[EvolutionV2] Evento de side-effect falhou:', evtErr.message);
        }

        res.json(success(populated));
    } catch (error) {
        console.error('[EvolutionV2] Erro ao atualizar:', error);
        res.status(500).json(failure('INTERNAL_ERROR', error.message));
    }
});

router.delete('/:id', flexibleAuth, async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json(failure('INVALID_ID', 'ID inválido'));
        }

        const evolution = await Evolution.findById(id);
        if (!evolution) {
            return res.status(404).json(failure('NOT_FOUND', 'Evolução não encontrada'));
        }

        const isOwner = evolution.doctor?.toString() === req.user?.id;
        if (!isAdmin(req.user) && !isOwner) {
            return res.status(403).json(failure('FORBIDDEN', 'Sem permissão para excluir'));
        }

        const patientId = evolution.patient?.toString?.();
        const doctorId = evolution.doctor?.toString?.();
        await evolution.deleteOne();

        // Side-effect event
        try {
            await publishEvent(EventTypes.EVOLUTION_DELETED, {
                evolutionId: id,
                patientId,
                doctorId,
            }, { correlationId: `evo_delete_${id}` });
        } catch (evtErr) {
            console.warn('[EvolutionV2] Evento de side-effect falhou:', evtErr.message);
        }

        res.json(success({ deleted: true, evolutionId: id }));
    } catch (error) {
        console.error('[EvolutionV2] Erro ao deletar:', error);
        res.status(500).json(failure('INTERNAL_ERROR', error.message));
    }
});

// ─── READS (diretos no MongoDB + escopo de profissional) ──────────────

router.get('/patient/:patientId', flexibleAuth, async (req, res) => {
    try {
        const { patientId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(patientId)) {
            return res.status(400).json(failure('INVALID_ID', 'ID de paciente inválido'));
        }

        const evolutions = await Evolution.find({ patient: patientId, ...FINALIZED_FILTER, ...getEvolutionScope(req) })
            .populate('doctor', 'fullName specialty')
            .populate('patient', 'fullName dateOfBirth')
            .sort({ date: -1 });

        res.json(success(evolutions));
    } catch (error) {
        console.error('[EvolutionV2] Erro ao listar:', error);
        res.status(500).json(failure('INTERNAL_ERROR', error.message));
    }
});

// Última evolução do paciente (para continuidade clínica)
router.get('/patient/:patientId/last', flexibleAuth, async (req, res) => {
    try {
        const { patientId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(patientId)) {
            return res.status(400).json(failure('INVALID_ID', 'ID de paciente inválido'));
        }

        // ?specialty= pré-preenche o modal com a última da mesma especialidade (rascunho não conta)
        const specialtyFilter = req.query.specialty ? { specialty: String(req.query.specialty) } : {};
        const lastEvolution = await Evolution.findOne({ patient: patientId, ...FINALIZED_FILTER, ...specialtyFilter, ...getEvolutionScope(req) })
            .populate('doctor', 'fullName specialty')
            .sort({ date: -1 });

        if (!lastEvolution) {
            return res.status(404).json(failure('NOT_FOUND', 'Nenhuma evolução encontrada para este paciente'));
        }

        res.json(success(lastEvolution));
    } catch (error) {
        console.error('[EvolutionV2] Erro ao buscar última evolução:', error);
        res.status(500).json(failure('INTERNAL_ERROR', error.message));
    }
});

router.get('/chart/:patientId', flexibleAuth, async (req, res) => {
    try {
        const { patientId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(patientId)) {
            return res.status(400).json(failure('INVALID_ID', 'ID de paciente inválido'));
        }

        // Entra quem tem métricas OU notas por área. Antes só entrava quem tinha métricas, e as
        // evoluções só com áreas sumiam do gráfico (cada área aparecia com "1 registro").
        const evolutions = await Evolution.find({
            patient: patientId,
            ...FINALIZED_FILTER,
            $or: [
                { metrics: { $exists: true, $not: { $size: 0 } } },
                { evaluationAreas: { $exists: true, $not: { $size: 0 } } }
            ],
            ...getEvolutionScope(req)
        }).sort({ date: 1 });

        const allMetrics = await Metric.find();
        const metricConfig = allMetrics.reduce((acc, metric) => {
            acc[metric.name] = metric;
            return acc;
        }, {});

        // 🎯 Monta datas únicas ordenadas
        const dates = evolutions.map(evo => evo.date.toISOString().split('T')[0]);
        const uniqueDates = [...new Set(dates)];

        // 🎯 Inicializa métricas com arrays alinhados às datas (null = não avaliado)
        const metricsMap = {};
        const evaluationAreasMap = {};

        uniqueDates.forEach((dateStr, dateIdx) => {
            // Pega todas as evoluções desta data (geralmente 1, mas pode haver mais)
            const dayEvolutions = evolutions.filter(evo =>
                evo.date.toISOString().split('T')[0] === dateStr
            );

            dayEvolutions.forEach(evo => {
                // Métricas numéricas
                if (evo.metrics && Array.isArray(evo.metrics)) {
                    evo.metrics.forEach(metric => {
                        if (!metric.name) return;
                        const metricName = metric.name;
                        if (!metricsMap[metricName]) {
                            metricsMap[metricName] = {
                                values: new Array(uniqueDates.length).fill(null),
                                config: metricConfig[metricName] || {}
                            };
                        }
                        // Se houver múltiplas evoluções no mesmo dia, usa a última
                        metricsMap[metricName].values[dateIdx] = metric.value;
                    });
                }

                // Áreas de avaliação com score (gráfico de barras/áreas)
                if (evo.evaluationAreas && Array.isArray(evo.evaluationAreas)) {
                    evo.evaluationAreas.forEach(area => {
                        const areaId = area.id || area.name;
                        if (!areaId) return;
                        if (!evaluationAreasMap[areaId]) {
                            evaluationAreasMap[areaId] = {
                                values: new Array(uniqueDates.length).fill(null),
                                label: area.name || areaId,
                                config: { color: metricConfig[areaId]?.color || null }
                            };
                        }
                        evaluationAreasMap[areaId].values[dateIdx] = area.score;
                    });
                }
            });
        });

        // Converte evaluationAreasMap para o formato que o frontend espera (evaluationTypes)
        const evaluationTypes = {};
        Object.entries(evaluationAreasMap).forEach(([key, data]) => {
            evaluationTypes[key] = data.values;
        });

        // Nome salvo de cada área (ex.: id "sd" → "Sílabas difíceis"), para o front não mostrar o id cru
        const evaluationLabels = {};
        Object.entries(evaluationAreasMap).forEach(([key, data]) => {
            evaluationLabels[key] = data.label;
        });

        const chartData = {
            dates: uniqueDates,
            metrics: metricsMap,
            evaluationTypes,
            evaluationLabels
        };

        res.json(success(chartData));
    } catch (error) {
        console.error('[EvolutionV2] Erro no chart:', error);
        res.status(500).json(failure('INTERNAL_ERROR', error.message));
    }
});

router.get('/patient/:patientId/progress', flexibleAuth, async (req, res) => {
    try {
        const { patientId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(patientId)) {
            return res.status(400).json(failure('INVALID_ID', 'ID de paciente inválido'));
        }

        const evolutions = await Evolution.find({
            patient: patientId,
            'therapeuticPlan.objectives': { $exists: true, $not: { $size: 0 } },
            ...FINALIZED_FILTER,
            ...getEvolutionScope(req)
        })
            .select('date metrics plan therapeuticPlan evaluationAreas treatmentStatus')
            .sort({ date: 1 });

        if (!evolutions.length) {
            return res.json(success({
                message: 'Nenhum plano terapêutico encontrado',
                objectives: []
            }));
        }

        const latest = evolutions[evolutions.length - 1];
        const currentPlan = latest.therapeuticPlan;

        const objectivesProgress = currentPlan.objectives.map(objective => {
            const areaHistory = evolutions
                .filter(ev => ev.evaluationAreas?.some(area => area.id === objective.area))
                .map(ev => ({
                    date: ev.date,
                    score: ev.evaluationAreas.find(area => area.id === objective.area)?.score || 0
                }));

            let trend = 'stable';
            if (areaHistory.length >= 2) {
                const recent = areaHistory.slice(-3).map(h => h.score);
                const diff = recent[recent.length - 1] - recent[0];
                if (diff > 0.5) trend = 'improving';
                else if (diff < -0.5) trend = 'regressing';
            }

            let projectedCompletion = null;
            if (objective.targetScore && areaHistory.length >= 2) {
                const firstScore = areaHistory[0].score;
                const lastScore = areaHistory[areaHistory.length - 1].score;
                const progress = lastScore - firstScore;
                const remaining = objective.targetScore - lastScore;
                if (progress > 0) {
                    const daysElapsed = (areaHistory[areaHistory.length - 1].date - areaHistory[0].date) / (1000 * 60 * 60 * 24);
                    const daysPerPoint = daysElapsed / progress;
                    const daysRemaining = daysPerPoint * remaining;
                    projectedCompletion = new Date(Date.now() + daysRemaining * 24 * 60 * 60 * 1000);
                }
            }

            return {
                area: objective.area,
                description: objective.description,
                target: objective.targetScore,
                current: objective.currentScore,
                progress: objective.progress,
                achieved: objective.achieved,
                trend,
                history: areaHistory,
                projectedCompletion,
                targetDate: objective.targetDate
            };
        });

        res.json(success({
            patient: latest.patient,
            currentPlan: {
                protocol: currentPlan.protocol,
                version: currentPlan.planVersion,
                reviewDate: currentPlan.reviewDate
            },
            objectives: objectivesProgress,
            totalSessions: evolutions.length,
            treatmentStatus: latest.treatmentStatus
        }));
    } catch (error) {
        console.error('[EvolutionV2] Erro no progress:', error);
        res.status(500).json(failure('INTERNAL_ERROR', error.message));
    }
});

router.get('/patient/:patientId/history', flexibleAuth, async (req, res) => {
    try {
        const { patientId } = req.params;
        const { limit = 50 } = req.query;

        if (!mongoose.Types.ObjectId.isValid(patientId)) {
            return res.status(400).json(failure('INVALID_ID', 'ID de paciente inválido'));
        }

        const evolutions = await Evolution.find({ patient: patientId, ...FINALIZED_FILTER, ...getEvolutionScope(req) })
            .select('_id date')
            .sort({ date: -1 })
            .limit(parseInt(limit));

        res.json(success(evolutions));
    } catch (error) {
        console.error('[EvolutionV2] Erro no history:', error);
        res.status(500).json(failure('INTERNAL_ERROR', error.message));
    }
});

router.get('/search', flexibleAuth, async (req, res) => {
    try {
        const { startDate, endDate, type, doctor, protocol } = req.query;
        let filter = {};

        if (startDate) filter.date = { $gte: new Date(startDate) };
        if (endDate) filter.date = { ...filter.date, $lte: new Date(endDate) };
        if (type) filter.sessionType = type;
        if (doctor) filter.doctor = doctor;
        if (protocol) filter.activeProtocols = protocol;

        const scope = getEvolutionScope(req);
        // limit opcional (ex.: "últimas 5 avaliações" na aba Evolução); sem ele mantém o comportamento antigo
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 0, 0), 100);
        let query = Evolution.find({ ...filter, ...FINALIZED_FILTER, ...scope })
            .populate('doctor', 'fullName specialty')
            .populate('patient', 'fullName')
            .sort({ date: -1, createdAt: -1 });
        if (limit) query = query.limit(limit);
        const evolutions = await query;

        res.json(success(evolutions));
    } catch (error) {
        console.error('[EvolutionV2] Erro na busca:', error);
        res.status(500).json(failure('INTERNAL_ERROR', error.message));
    }
});

// ─── MÉTRICAS ─────────────────────────────────────────────────────────

router.get('/metrics', flexibleAuth, async (req, res) => {
    try {
        const metrics = await Metric.find();
        res.json(success(metrics));
    } catch (error) {
        console.error('[EvolutionV2] Erro ao buscar métricas:', error);
        res.status(500).json(failure('INTERNAL_ERROR', error.message));
    }
});

// ─── PENDÊNCIAS (pacientes atendidos sem evolução) ────────────────────
// Paciente pendente = teve atendimento concluído (completed/paid) nos últimos
// 90 dias com o profissional e não tem evolução desse profissional no mesmo
// dia ou depois do último atendimento. Calculado no backend (invariante 7).

const PENDING_WINDOW_DAYS = 90;
const ymd = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

router.get('/pending', flexibleAuth, async (req, res) => {
    try {
        const doctorIdRaw = isAdmin(req.user) && req.query.doctorId ? req.query.doctorId : req.user?.id;
        if (!doctorIdRaw || !mongoose.Types.ObjectId.isValid(doctorIdRaw)) {
            return res.status(400).json(failure('INVALID_DOCTOR', 'Profissional inválido'));
        }
        const doctor = new mongoose.Types.ObjectId(doctorIdRaw);
        const now = new Date();
        const since = new Date(now.getTime() - PENDING_WINDOW_DAYS * 24 * 60 * 60 * 1000);

        const attended = await Appointment.aggregate([
            {
                $match: {
                    doctor,
                    patient: { $ne: null },
                    operationalStatus: { $in: ['completed', 'paid'] },
                    date: { $gte: since, $lte: now }
                }
            },
            { $sort: { date: -1 } },
            // O agendamento mais recente vai junto: é nele que o rascunho/evolução fica preso.
            { $group: { _id: '$patient', lastCompletedDate: { $first: '$date' }, lastAppointmentId: { $first: '$_id' }, lastCompletedTime: { $first: '$time' } } }
        ]);

        if (attended.length === 0) return res.json(success([], { count: 0 }));

        const evolutions = await Evolution.aggregate([
            { $match: { doctor, patient: { $in: attended.map(a => a._id) }, ...FINALIZED_FILTER } },
            { $group: { _id: '$patient', lastEvolutionDate: { $max: '$date' } } }
        ]);
        const lastEvoByPatient = new Map(evolutions.map(e => [String(e._id), e.lastEvolutionDate]));

        const pending = attended.filter(a => {
            const lastEvo = lastEvoByPatient.get(String(a._id));
            return !lastEvo || ymd(lastEvo) < ymd(a.lastCompletedDate);
        });

        if (pending.length === 0) return res.json(success([], { count: 0 }));

        const patients = await Patient.find({
            _id: { $in: pending.map(p => p._id) },
            status: { $nin: ['inactive', 'lead'] },
            isLead: { $ne: true }
        }).select('fullName').lean();
        const nameById = new Map(patients.map(p => [String(p._id), p.fullName]));

        // Rascunho em andamento continua pendente, mas a tela mostra "Continuar rascunho".
        const drafts = await Evolution.find({ doctor, status: 'draft', patient: { $in: pending.map(p => p._id) } })
            .select('patient appointmentId lastAutosaveAt').sort({ lastAutosaveAt: -1 }).lean();
        const draftByPatient = new Map();
        for (const d of drafts) if (!draftByPatient.has(String(d.patient))) draftByPatient.set(String(d.patient), d);

        const data = pending
            .filter(p => nameById.has(String(p._id)))
            .map(p => ({
                _id: p._id,
                fullName: nameById.get(String(p._id)),
                lastCompletedDate: p.lastCompletedDate,
                lastAppointmentId: p.lastAppointmentId || null,
                lastCompletedTime: p.lastCompletedTime || null,
                lastEvolutionDate: lastEvoByPatient.get(String(p._id)) || null,
                draft: draftByPatient.has(String(p._id)) ? {
                    evolutionId: draftByPatient.get(String(p._id))._id,
                    appointmentId: draftByPatient.get(String(p._id)).appointmentId || null,
                    lastAutosaveAt: draftByPatient.get(String(p._id)).lastAutosaveAt || null
                } : null
            }))
            .sort((a, b) => new Date(a.lastCompletedDate) - new Date(b.lastCompletedDate));

        res.json(success(data, { count: data.length }));
    } catch (error) {
        console.error('[EvolutionV2] Erro ao buscar pendências:', error);
        res.status(500).json(failure('INTERNAL_ERROR', error.message));
    }
});

// ─── PDF (síncrono) ───────────────────────────────────────────────────

router.get('/:id/pdf', flexibleAuth, async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json(failure('INVALID_ID', 'ID inválido'));
        }

        const evolution = await Evolution.findById(id)
            .populate('patient', 'fullName dateOfBirth')
            .populate('doctor', 'fullName specialty');

        if (!evolution) {
            return res.status(404).json(failure('NOT_FOUND', 'Evolução não encontrada'));
        }

        const pdfBuffer = await generatePdfFromEvolution(evolution);
        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="evolucao-${evolution._id}.pdf"`
        });
        res.send(pdfBuffer);
    } catch (error) {
        console.error('[EvolutionV2] Erro ao gerar PDF:', error);
        res.status(500).json(failure('INTERNAL_ERROR', error.message));
    }
});

export default router;
