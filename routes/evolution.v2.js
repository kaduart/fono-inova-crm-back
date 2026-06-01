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
import Evolution from '../models/Evolution.js';
import Metric from '../models/Metric.js';
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

        const doc = new Evolution({
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
        Object.assign(evolution, req.body);

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

        const evolutions = await Evolution.find({ patient: patientId, ...getEvolutionScope(req) })
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

        const lastEvolution = await Evolution.findOne({ patient: patientId, ...getEvolutionScope(req) })
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

        const evolutions = await Evolution.find({
            patient: patientId,
            metrics: { $exists: true, $not: { $size: 0 } },
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

        const chartData = {
            dates: uniqueDates,
            metrics: metricsMap,
            evaluationTypes
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

        const evolutions = await Evolution.find({ patient: patientId, ...getEvolutionScope(req) })
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
        const evolutions = await Evolution.find({ ...filter, ...scope })
            .populate('doctor', 'fullName specialty')
            .populate('patient', 'fullName')
            .sort({ date: -1 });

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
