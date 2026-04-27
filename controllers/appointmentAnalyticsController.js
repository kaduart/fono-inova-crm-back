import Appointment from '../models/Appointment.js';
import Patient from '../models/Patient.js';
import mongoose from 'mongoose';

/**
 * 📊 Analytics de Agendamentos - Novos vs Retornos
 * Endpoint específico para secretaria/recepção identificar
 * agendamentos do dia que precisam de atenção especial.
 */

const DAY_IN_MS = 1000 * 60 * 60 * 24;

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
        // operationalStatus === 'pre_agendado' (ainda não convertido)
        // NOTA: 'converted' foi removido do domínio — pré-agendamentos convertidos viram 'canceled'
        // com metadata.convertedToAppointmentId, e um novo appointment 'scheduled' é criado.
        // 🎯 FIX: Só é lead se for pré-agendamento DE UM NOVO PACIENTE (sem histórico).
        // Pacientes existentes que fazem pré-agendamento não são leads.
        const isLead = apt.operationalStatus === 'pre_agendado' && isFirstVisit;

        if (isLead) {
            return { ...apt, isLead: true, isFirstVisit: true, isReturningAfter45Days: false };
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

        let isReturningAfter45Days = false;
        if (earlierSameSpecialty.length > 0) {
            const lastPrevious = earlierSameSpecialty[earlierSameSpecialty.length - 1];
            const diffDays = (new Date(apt.date) - new Date(lastPrevious.date)) / DAY_IN_MS;
            isReturningAfter45Days = diffDays >= 45;
        }

        return { ...apt, isLead: false, isFirstVisit, isReturningAfter45Days };
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
        // No modo operacional (date), excluímos cancelados para não poluir a agenda
        if (mode === 'date') {
            extraFilters.operationalStatus = { $nin: ['canceled', 'cancelled'] };
        }

        const filter = { ...dateFilter, ...extraFilters };

        // ─── 3. Buscar agendamentos do período (com população completa) ───
        console.log('[Analytics] main filter:', JSON.stringify(filter));
        const appointments = await Appointment.find(filter)
            .populate('patient', 'fullName phone email dateOfBirth cpf')
            .populate('doctor', 'fullName specialty phoneNumber')
            .populate('session', 'status notes')
            .populate('package', 'totalSessions sessionsDone totalPaid totalValue financialStatus sessionValue type')
            .populate('payment', 'status amount paymentMethod billingType kind insuranceValue')
            .sort({ date: 1, time: 1 })
            .lean();
        console.log('[Analytics] main appointments count:', appointments.length);

        // 🎯 FIX: No modo 'date' a intenção é uma visão OPERACIONAL + AQUISIÇÃO:
        // buscamos os agendamentos do período (date) E os pré-agendados criados
        // no período (createdAt), mesmo que sua consulta real seja futura.
        let preAgendamentos = [];
        if (mode === 'date') {
            const createdAtFilter = {};
            if (date) {
                createdAtFilter.createdAt = {
                    $gte: new Date(date + 'T00:00:00.000Z'),
                    $lte: new Date(date + 'T23:59:59.999Z')
                };
            } else if (startDate && endDate) {
                createdAtFilter.createdAt = {
                    $gte: new Date(startDate + 'T00:00:00.000Z'),
                    $lte: new Date(endDate + 'T23:59:59.999Z')
                };
            } else {
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const tomorrow = new Date(today);
                tomorrow.setDate(tomorrow.getDate() + 1);
                createdAtFilter.createdAt = { $gte: today, $lt: tomorrow };
            }
            
            const preFilter = {
                ...createdAtFilter,
                operationalStatus: 'pre_agendado'
            };
            if (doctorId) preFilter.doctor = new mongoose.Types.ObjectId(doctorId);
            if (specialty) preFilter.specialty = specialty.toLowerCase();
            
            console.log('[Analytics] preFilter:', JSON.stringify(preFilter));
            preAgendamentos = await Appointment.find(preFilter)
                .populate('patient', 'fullName phone email dateOfBirth cpf')
                .populate('doctor', 'fullName specialty phoneNumber')
                .populate('session', 'status notes')
                .populate('package', 'totalSessions sessionsDone totalPaid totalValue financialStatus sessionValue type')
                .populate('payment', 'status amount paymentMethod billingType kind insuranceValue')
                .sort({ date: 1, time: 1 })
                .lean();
            console.log('[Analytics] preAgendamentos count:', preAgendamentos.length);
            if (preAgendamentos.length > 0) {
                console.log('[Analytics] preAgendamentos ids:', preAgendamentos.map(p => ({ _id: p._id, operationalStatus: p.operationalStatus, createdAt: p.createdAt, date: p.date })));
            }
        }

        // Deduplica pré-agendamentos: mesmo _id OU mesmo paciente já no pool principal
        const appointmentIds = new Set(appointments.map(a => a._id.toString()));
        const patientIdsInMainPool = new Set(
            appointments
                .filter(a => a.patient?._id)
                .map(a => a.patient._id.toString())
        );
        const uniquePreAgendamentos = preAgendamentos
            .filter(p => {
                if (appointmentIds.has(p._id.toString())) return false;
                const pid = p.patient?._id?.toString?.();
                if (pid && patientIdsInMainPool.has(pid)) return false;
                return true;
            })
            .map(p => ({ ...p, origin: 'pre_agendamento' }));

        const allAppointments = [
            ...appointments,
            ...uniquePreAgendamentos
        ];

        // ─── 4. Buscar histórico completo dos pacientes envolvidos ───
        const patientIds = [
            ...new Set(
                allAppointments
                    .filter(a => a.patient && typeof a.patient === 'object' && a.patient._id)
                    .map(a => a.patient._id.toString())
            )
        ];

        let patientHistoryMap = new Map();
        if (patientIds.length > 0) {
            const histories = await Appointment.find({
                patient: { $in: patientIds.map(id => new mongoose.Types.ObjectId(id)) },
                operationalStatus: { $nin: ['pre_agendado', 'canceled', 'cancelled'] }
            })
                .select('patient date specialty createdAt operationalStatus')
                .lean();

            histories.forEach(h => {
                const pid = h.patient?.toString?.();
                if (!pid) return;
                if (!patientHistoryMap.has(pid)) patientHistoryMap.set(pid, []);
                patientHistoryMap.get(pid).push(h);
            });
        }

        // ─── 5. Calcular flags de lifecycle ───
        const enrichedAppointments = computeLifecycleFlags(allAppointments, patientHistoryMap);

        // ─── 6. Separar categorias ───
        // NÍVEL CEO: separação clara entre aquisição, primeira visita e retenção
        // 🎯 FIX: No modo 'date', leads converted (first-visit) só contam se foram
        // criados no período. Pre-agendados continuam contando pela data da consulta.
        let leads = enrichedAppointments.filter(a => a.isLead);
        if (mode === 'date') {
            const periodStartStr = date || startDate;
            const periodEndStr = date || endDate;
            if (periodStartStr && periodEndStr) {
                leads = leads.filter(a => {
                    if (a.operationalStatus === 'pre_agendado') return true;
                    const createdAt = new Date(a.createdAt).toISOString().split('T')[0];
                    return createdAt >= periodStartStr && createdAt <= periodEndStr;
                });
            }
        }

        const novos = enrichedAppointments.filter(a => a.isFirstVisit && !a.isLead);
        const retornos45 = enrichedAppointments.filter(a => a.isReturningAfter45Days);
        const recorrentes = enrichedAppointments.filter(
            a => !a.isLead && !a.isFirstVisit && !a.isReturningAfter45Days
        );

        const total = enrichedAppointments.length;
        console.log('[Analytics] final counts -> total:', total, 'leads:', leads.length, 'novos:', novos.length, 'retornos45:', retornos45.length, 'recorrentes:', recorrentes.length);

        res.json({
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
                retornos45: {
                    count: retornos45.length,
                    percentage: total > 0 ? Math.round((retornos45.length / total) * 100) : 0
                },
                recorrentes: {
                    count: recorrentes.length,
                    percentage: total > 0 ? Math.round((recorrentes.length / total) * 100) : 0
                }
            },
            details: {
                leads,
                novos,
                retornos45,
                recorrentes,
                all: enrichedAppointments
            }
        });

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
