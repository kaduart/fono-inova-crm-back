import Appointment from '../models/Appointment.js';
import Patient from '../models/Patient.js';
import mongoose from 'mongoose';
import { isInsuranceAppointment } from '../utils/appointmentMapper.js';
import { safeRedis } from '../config/redisConnection.js';

const DAY_IN_MS = 1000 * 60 * 60 * 24;

// Cache Redis para analytics/by-type — compartilhado entre instâncias no Render
const REDIS_PREFIX = 'analytics:by-type:';
const REDIS_TTL_CURRENT_SECONDS = 120;   // 2 min para período atual
const REDIS_TTL_PAST_SECONDS = 1800;     // 30 min para períodos passados

// Cache local de fallback (quando Redis indisponível)
const BY_TYPE_CURRENT_TTL = 30_000;
const BY_TYPE_PAST_TTL    = 24 * 60 * 60 * 1000;
const _byTypeCache = new Map();

function _byTypeCacheKey(mode, startDate, endDate, date, doctorId, specialty) {
    return `${mode}_${startDate || ''}_${endDate || ''}_${date || ''}_${doctorId || ''}_${specialty || ''}`;
}

function _redisKey(mode, startDate, endDate, date, doctorId, specialty) {
    return `${REDIS_PREFIX}${_byTypeCacheKey(mode, startDate, endDate, date, doctorId, specialty)}`;
}

async function _redisCacheGet(key) {
    try {
        const raw = await safeRedis.get(key);
        if (!raw) return null;
        const entry = JSON.parse(raw);
        if (!entry || !entry._cachedAt) return null;
        return entry;
    } catch (e) {
        console.warn('[by-type] Redis cache read failed:', e.message);
        return null;
    }
}

async function _redisCacheSet(key, data, ttlSeconds) {
    try {
        await safeRedis.setex(key, ttlSeconds, JSON.stringify({ ...data, _cachedAt: new Date().toISOString() }));
    } catch (e) {
        console.warn('[by-type] Redis cache write failed:', e.message);
    }
}

function _localCacheGet(key, ttl) {
    const entry = _byTypeCache.get(key);
    if (entry && Date.now() - entry.ts < ttl) {
        console.log(`[by-type] LOCAL HIT ${key} (age=${Date.now() - entry.ts}ms ttl=${ttl}ms)`);
        return entry.data;
    }
    return null;
}

function _localCacheSet(key, data) {
    _byTypeCache.set(key, { data, ts: Date.now() });
    if (_byTypeCache.size > 50) {
        const oldest = _byTypeCache.keys().next().value;
        _byTypeCache.delete(oldest);
    }
}

async function _byTypeCacheGet(mode, startDate, endDate, date, doctorId, specialty, ttlSeconds) {
    const key = _byTypeCacheKey(mode, startDate, endDate, date, doctorId, specialty);
    const redisEntry = await _redisCacheGet(_redisKey(mode, startDate, endDate, date, doctorId, specialty));
    if (redisEntry) {
        const ageMs = Date.now() - new Date(redisEntry._cachedAt).getTime();
        console.log(`[by-type] REDIS HIT ${key} (age=${Math.round(ageMs/1000)}s ttl=${ttlSeconds}s)`);
        return redisEntry;
    }
    const localEntry = _localCacheGet(key, ttlSeconds * 1000);
    if (localEntry) return localEntry;
    return null;
}

async function _byTypeCacheSet(mode, startDate, endDate, date, doctorId, specialty, data, ttlSeconds) {
    const key = _byTypeCacheKey(mode, startDate, endDate, date, doctorId, specialty);
    _localCacheSet(key, data);
    await _redisCacheSet(_redisKey(mode, startDate, endDate, date, doctorId, specialty), data, ttlSeconds);
    console.log(`[by-type] CACHE SET ${key}`);
}

/**
 * Invalida cache Redis/Local para analytics/by-type.
 * Útil para chamar após mutações em agendamentos.
 */
export function invalidateByTypeCache() {
    const size = _byTypeCache.size;
    _byTypeCache.clear();
    console.log(`[by-type] Cache local invalidado (${size} entradas limpas)`);
    // Não limpamos o Redis por prefixo aqui para evitar operações pesadas;
    // cada entrada expira pelo TTL.
}

/**
 * Calcula flags de lifecycle para uma lista de agendamentos.
 * 
 * Regras:
 * 1. isFirstVisit = true quando:
 *    - O agendamento não tem patientId vinculado (pré-cadastro), OU
 *    - É o primeiro agendamento ever daquele paciente no sistema
 * 
 * 2. isReturningAfter45Days = true quando:
 *    - O paciente JÁ possui histórico na mesma especialidade, E
 *    - O gap entre o último agendamento anterior (mesma specialty) e o atual é >= 45 dias
 */
function computeLifecycleFlags(appointments, patientHistoryMap) {
    return appointments.map(apt => {
        const pid = apt.patient?._id?.toString?.() || apt.patient?.toString?.();
        const history = patientHistoryMap.get(pid) || [];

        // Ordenar todo o histórico do paciente por createdAt (fallback: _id)
        const sortedByCreated = [...history].sort((a, b) => {
            const diff = new Date(a.createdAt) - new Date(b.createdAt);
            if (diff !== 0) return diff;
            return a._id.toString().localeCompare(b._id.toString());
        });

        // isFirstVisit: não existe nenhum outro agendamento criado antes deste
        const earlierAppointments = sortedByCreated.filter(
            h => h._id.toString() !== apt._id.toString() &&
                (new Date(h.createdAt) < new Date(apt.createdAt) ||
                 (new Date(h.createdAt).getTime() === new Date(apt.createdAt).getTime() &&
                  h._id.toString() < apt._id.toString()))
        );
        const isFirstVisit = earlierAppointments.length === 0;

        // 🔥 Fonte de verdade para lead:
        // - pre_agendado particular → funil de aquisição clássico (sempre lead)
        // - scheduled + isFirstVisit → agendamento direto de paciente novo
        // - convênio excluído: sessões geradas pelo plano NÃO são leads
        // Liminar = tratamento judicial contínuo — nunca é lead nem aquisição
        const isLiminar = apt.billingType === 'liminar' || apt.serviceType === 'liminar_session'
            || apt.patientJourneyType === 'continuous_treatment';
        if (isLiminar) {
            return { ...apt, isLead: false, isFirstVisit: false, isFirstVisitInSpecialty: false, isReturningAfter45Days: false, isContinuousTreatment: true };
        }

        // package_session pressupõe pacote já comprado — nunca é 1ª visita.
        // Sessões do pacote são criadas com mesmo createdAt, causando falso-positivo de isFirstVisit.
        if (apt.serviceType === 'package_session' && isFirstVisit) {
            return { ...apt, isLead: false, isFirstVisit: false, isFirstVisitInSpecialty: false, isReturningAfter45Days: false, isContinuousTreatment: false };
        }

        const isConvenioSession = isInsuranceAppointment(apt);
        // Desde 2026-05-07 TODOS os appointments nascem como pre_agendado — inclusive retornos.
        // Lead = genuinamente nova pessoa na clínica (isFirstVisit obrigatório).
        const isLead = !isConvenioSession && isFirstVisit && (
            apt.operationalStatus === 'pre_agendado' ||
            apt.operationalStatus === 'scheduled'
        );

        if (isLead) {
            return { ...apt, isLead: true, isFirstVisit, isReturningAfter45Days: false, isContinuousTreatment: false };
        }

        // isReturningAfter45Days: olhar histórico na MESMA especialidade (por date)
        const sameSpecialty = history
            .filter(h => h.specialty === apt.specialty && h._id.toString() !== apt._id.toString())
            .sort((a, b) => new Date(a.date) - new Date(b.date));

        const earlierSameSpecialty = sameSpecialty.filter(
            h => new Date(h.date) < new Date(apt.date) ||
                (new Date(h.date).getTime() === new Date(apt.date).getTime() &&
                 h._id.toString() < apt._id.toString())
        );

        // 🎯 Ativo na especialidade = teve agendamento nos últimos 45 dias (inclui pre_agendado).
        // Se tem pré-agendamento recente da mesma especialidade, é continuidade clínica.
        const recentSameSpecialty = earlierSameSpecialty.filter(
            h => (new Date(apt.date) - new Date(h.date)) / DAY_IN_MS <= 45
        );
        const isFirstVisitInSpecialty = recentSameSpecialty.length === 0;

        // 🎯 Retorno 45+ = última sessão CONCRETA (exclui pre_agendado) foi há +45 dias.
        // Pré-agendamento antigo não conta como "sessão realizada" para fins de gap.
        const concreteEarlierSameSpecialty = earlierSameSpecialty.filter(
            h => h.operationalStatus !== 'pre_agendado'
        );
        let isReturningAfter45Days = false;
        if (concreteEarlierSameSpecialty.length > 0) {
            const lastPrevious = concreteEarlierSameSpecialty[concreteEarlierSameSpecialty.length - 1];
            const diffDays = (new Date(apt.date) - new Date(lastPrevious.date)) / DAY_IN_MS;
            isReturningAfter45Days = diffDays >= 45;
        }

        return { ...apt, isLead: false, isFirstVisit, isFirstVisitInSpecialty, isReturningAfter45Days, isContinuousTreatment: false };
    });
}

/**
 * GET /analytics/appointments/by-type
 * 
 * Retorna agendamentos do período (padrão: hoje) enriquecidos com:
 * - isFirstVisit
 * - isReturningAfter45Days
 * 
 * Query params:
 * - date: data específica (YYYY-MM-DD) - padrão: hoje
 * - startDate, endDate: período
 * - doctorId: filtrar por médico
 * - specialty: filtrar por especialidade
 */
export const getAppointmentsByType = async (req, res) => {
    try {
        const { date, startDate, endDate, doctorId, specialty, mode = 'createdAt' } = req.query;

        // Cache: 2min se período inclui hoje, 30min para períodos passados
        const periodEnd = endDate || date || new Date().toISOString().split('T')[0];
        const todayStr = new Date().toISOString().split('T')[0];
        const isCurrent = periodEnd >= todayStr;
        const cacheTTLSeconds = isCurrent ? REDIS_TTL_CURRENT_SECONDS : REDIS_TTL_PAST_SECONDS;
        const cacheKey = _byTypeCacheKey(mode, startDate, endDate, date, doctorId, specialty);
        const cached = await _byTypeCacheGet(mode, startDate, endDate, date, doctorId, specialty, cacheTTLSeconds);
        if (cached) return res.json(cached);

        // mode = 'createdAt' → visão comercial (quando o lead entrou)
        // mode = 'date'      → visão operacional (quando será atendido)
        const dateField = mode === 'date' ? 'date' : 'createdAt';

        // ─── 1. Definir filtro de período ───
        let dateFilter = {};

        if (date) {
            dateFilter = {
                [dateField]: {
                    $gte: new Date(date + 'T00:00:00.000Z'),
                    $lte: new Date(date + 'T23:59:59.999Z')
                }
            };
        } else if (startDate && endDate) {
            dateFilter = {
                [dateField]: {
                    $gte: new Date(startDate + 'T00:00:00.000Z'),
                    $lte: new Date(endDate + 'T23:59:59.999Z')
                }
            };
        } else {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const tomorrow = new Date(today);
            tomorrow.setDate(tomorrow.getDate() + 1);
            dateFilter = { [dateField]: { $gte: today, $lt: tomorrow } };
        }

        // ─── 2. Filtros extras ───
        const extraFilters = {};
        if (doctorId) {
            extraFilters.doctor = new mongoose.Types.ObjectId(doctorId);
        }
        if (specialty) {
            extraFilters.specialty = specialty.toLowerCase();
        }
        // Excluímos cancelados/convertidos em qualquer modo — não são agendamentos válidos para métricas
        extraFilters.operationalStatus = { $nin: ['canceled', 'cancelled', 'converted'] };

        const filter = { ...dateFilter, ...extraFilters };
        const _t0 = Date.now();

        // ─── 3. Buscar agendamentos do período com aggregation + lookup projetado ───
        // 🚀 Substitui find().populate() duplo por uma única aggregate.
        // No modo 'date' usa $or para unir agendamentos do período (date) e criados no período (createdAt),
        // evitando duas queries separadas, duplo populate e deduplicação manual.
        const rangeStart = date ? new Date(date + 'T00:00:00.000Z')
            : (startDate ? new Date(startDate + 'T00:00:00.000Z') : (() => {
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                return today;
            })());
        const rangeEnd = date ? new Date(date + 'T23:59:59.999Z')
            : (endDate ? new Date(endDate + 'T23:59:59.999Z') : (() => {
                const tomorrow = new Date(rangeStart);
                tomorrow.setDate(tomorrow.getDate() + 1);
                return tomorrow;
            })());

        const lookupPatient = {
            $lookup: {
                from: 'patients',
                localField: 'patient',
                foreignField: '_id',
                as: 'patient',
                pipeline: [{ $project: { fullName: 1 } }]
            }
        };
        const lookupDoctor = {
            $lookup: {
                from: 'doctors',
                localField: 'doctor',
                foreignField: '_id',
                as: 'doctor',
                pipeline: [{ $project: { fullName: 1, specialty: 1 } }]
            }
        };

        let allAppointments;
        if (mode === 'date') {
            const matchStage = {
                $or: [
                    {
                        date: { $gte: rangeStart, $lte: rangeEnd },
                        operationalStatus: { $nin: ['canceled', 'cancelled', 'converted'] }
                    },
                    {
                        createdAt: { $gte: rangeStart, $lte: rangeEnd },
                        operationalStatus: { $in: ['pre_agendado', 'scheduled'] }
                    }
                ]
            };
            if (doctorId) matchStage.doctor = new mongoose.Types.ObjectId(doctorId);
            if (specialty) matchStage.specialty = specialty.toLowerCase();

            allAppointments = await Appointment.aggregate([
                { $match: matchStage },
                {
                    $addFields: {
                        _matchesDate: {
                            $and: [
                                { $gte: ['$date', rangeStart] },
                                { $lte: ['$date', rangeEnd] },
                                { $not: { $in: ['$operationalStatus', ['canceled', 'cancelled', 'converted']] } }
                            ]
                        }
                    }
                },
                lookupPatient,
                { $unwind: { path: '$patient', preserveNullAndEmptyArrays: true } },
                lookupDoctor,
                { $unwind: { path: '$doctor', preserveNullAndEmptyArrays: true } },
                {
                    $addFields: {
                        origin: {
                            $cond: {
                                if: '$_matchesDate',
                                then: '$$REMOVE',
                                else: { $cond: { if: { $eq: ['$operationalStatus', 'pre_agendado'] }, then: 'pre_agendamento', else: 'agendado_hoje' } }
                            }
                        }
                    }
                },
                { $project: { _matchesDate: 0 } },
                { $sort: { date: 1, time: 1 } }
            ]).allowDiskUse(true);
        } else {
            allAppointments = await Appointment.aggregate([
                { $match: filter },
                lookupPatient,
                { $unwind: { path: '$patient', preserveNullAndEmptyArrays: true } },
                lookupDoctor,
                { $unwind: { path: '$doctor', preserveNullAndEmptyArrays: true } },
                { $sort: { date: 1, time: 1 } }
            ]).allowDiskUse(true);
        }
        console.log(`[by-type] appointments.aggregate+lookup = ${Date.now() - _t0}ms (${allAppointments.length} docs)`);

        // ─── 4. Buscar histórico completo dos pacientes envolvidos ───
        // Suporta patient populado (objeto) OU não populado (string/ObjectId)
        const patientIds = [
            ...new Set(
                allAppointments
                    .map(a => {
                        if (!a.patient) return null;
                        if (typeof a.patient === 'object') return a.patient._id?.toString() || null;
                        if (typeof a.patient === 'string') return a.patient;
                        return a.patient?.toString?.() || null;
                    })
                    .filter(Boolean)
            )
        ];

        let patientHistoryMap = new Map();
        if (patientIds.length > 0) {
            // Olhar só 46 dias antes do appointment mais antigo do período:
            // - isFirstVisit: paciente novo no período não tem anterior
            // - retorno 45+: gap mínimo é 45 dias
            // - isFirstVisitInSpecialty: só importa agendamentos nos últimos 45 dias
            const minAptDate = allAppointments.reduce((min, a) => {
                const d = a.date ? new Date(a.date) : null;
                return d && d < min ? d : min;
            }, new Date());
            const historyLookback = new Date(minAptDate);
            historyLookback.setDate(historyLookback.getDate() - 46);

            const _tHistory = Date.now();
            const histories = await Appointment.find({
                patient: { $in: patientIds.map(id => new mongoose.Types.ObjectId(id)) },
                operationalStatus: { $nin: ['canceled', 'cancelled'] },
                createdAt: { $gte: historyLookback }
            })
                .select('patient date specialty createdAt operationalStatus')
                .lean();
            console.log(`[by-type] patientHistory = ${Date.now() - _tHistory}ms (${histories.length} docs, ${patientIds.length} patients)`);

            histories.forEach(h => {
                const pid = h.patient?.toString?.();
                if (!pid) return;
                if (!patientHistoryMap.has(pid)) patientHistoryMap.set(pid, []);
                patientHistoryMap.get(pid).push(h);
            });
        }

        // ─── 5. Calcular flags de lifecycle ───
        const _tFlags = Date.now();
        const enrichedAppointments = computeLifecycleFlags(allAppointments, patientHistoryMap);
        console.log(`[by-type] computeLifecycleFlags = ${Date.now() - _tFlags}ms (${allAppointments.length} appointments)`);

        // ─── 6. Separar categorias ───
        // Leads (pré-agendados novos) contam pela data em que foram CRIADOS no sistema.
        let leads = enrichedAppointments.filter(a => a.isLead);
        if (mode === 'date') {
            const periodStartStr = date || startDate;
            const periodEndStr = date || endDate;
            if (periodStartStr && periodEndStr) {
                leads = leads.filter(a => {
                    const createdAt = new Date(a.createdAt).toISOString().split('T')[0];
                    return createdAt >= periodStartStr && createdAt <= periodEndStr;
                });
            }
        }

        const continuousTreatment = enrichedAppointments.filter(a => a.isContinuousTreatment);
        const acquisitionPool = enrichedAppointments.filter(a => !a.isContinuousTreatment);

        const novos = acquisitionPool.filter(a => a.isFirstVisit && !a.isLead);
        const novosEspecialidade = acquisitionPool.filter(
            a => !a.isLead && !a.isFirstVisit && a.isFirstVisitInSpecialty && !a.isReturningAfter45Days
        );
        const retornos45 = acquisitionPool.filter(a => a.isReturningAfter45Days);
        const recorrentes = acquisitionPool.filter(
            a => !a.isLead && !a.isFirstVisit && !a.isFirstVisitInSpecialty && !a.isReturningAfter45Days
        );

        const total = enrichedAppointments.length;
        console.log(`[analytics/by-type] ✅ Resultado: total=${total} | leads=${leads.length} | novos=${novos.length} | novosEspecialidade=${novosEspecialidade.length} | retornos45=${retornos45.length} | recorrentes=${recorrentes.length} | continuousTreatment=${continuousTreatment.length} | TOTAL=${Date.now() - _t0}ms`);

        const responseBody = {
            success: true,
            mode,
            dateField,
            period: {
                date: date || new Date().toISOString().split('T')[0],
                startDate: startDate || null,
                endDate: endDate || null
            },
            summary: {
                total,
                leads: {
                    count: leads.length,
                    percentage: total > 0 ? Math.round((leads.length / total) * 100) : 0
                },
                novos: {
                    count: novos.length,
                    percentage: total > 0 ? Math.round((novos.length / total) * 100) : 0
                },
                novosEspecialidade: {
                    count: novosEspecialidade.length,
                    percentage: total > 0 ? Math.round((novosEspecialidade.length / total) * 100) : 0
                },
                retornos45: {
                    count: retornos45.length,
                    percentage: total > 0 ? Math.round((retornos45.length / total) * 100) : 0
                },
                recorrentes: {
                    count: recorrentes.length,
                    percentage: total > 0 ? Math.round((recorrentes.length / total) * 100) : 0
                },
                continuousTreatment: {
                    count: continuousTreatment.length,
                    percentage: total > 0 ? Math.round((continuousTreatment.length / total) * 100) : 0
                }
            },
            details: {
                leads,
                novos,
                novosEspecialidade,
                retornos45,
                recorrentes,
                continuousTreatment,
                all: enrichedAppointments
            }
        };

        await _byTypeCacheSet(mode, startDate, endDate, date, doctorId, specialty, responseBody, cacheTTLSeconds);
        res.json(responseBody);

    } catch (error) {
        console.error('❌ Erro em getAppointmentsByType:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao analisar agendamentos',
            error: error.message
        });
    }
};

/**
 * GET /analytics/appointments/conversion-timeline
 * 
 * Timeline de conversão: quando leads viraram pacientes (primeiro agendamento)
 * Útil para ver efetividade de campanhas
 */
export const getConversionTimeline = async (req, res) => {
    try {
        const { days = 30 } = req.query;

        const startDate = new Date();
        startDate.setDate(startDate.getDate() - parseInt(days));

        // Buscar primeiros agendamentos no período
        const firstAppointments = await Appointment.aggregate([
            // Agrupa por paciente e pega o primeiro
            {
                $group: {
                    _id: '$patient',
                    firstAppointment: { $min: '$createdAt' },
                    appointmentData: { $first: '$$ROOT' }
                }
            },
            // Filtra só os que converteram no período
            {
                $match: {
                    firstAppointment: { $gte: startDate }
                }
            },
            // Ordena por data
            {
                $sort: { firstAppointment: 1 }
            },
            // Popula dados do paciente
            {
                $lookup: {
                    from: 'patients',
                    localField: '_id',
                    foreignField: '_id',
                    as: 'patient'
                }
            },
            { $unwind: '$patient' }
        ]);

        // Agrupa por dia
        const byDay = firstAppointments.reduce((acc, item) => {
            const dateKey = item.firstAppointment.toISOString().split('T')[0];
            if (!acc[dateKey]) {
                acc[dateKey] = { count: 0, patients: [] };
            }
            acc[dateKey].count++;
            acc[dateKey].patients.push({
                name: item.patient.name,
                phone: item.patient.phone,
                date: item.firstAppointment
            });
            return acc;
        }, {});

        res.json({
            success: true,
            period: `${days} dias`,
            totalConversions: firstAppointments.length,
            dailyBreakdown: byDay
        });

    } catch (error) {
        console.error('❌ Erro em getConversionTimeline:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao buscar timeline de conversão',
            error: error.message
        });
    }
};
