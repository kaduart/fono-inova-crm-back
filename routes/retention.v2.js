// routes/retention.v2.js
/**
 * Retenção Clínica V2
 *
 * GET /api/v2/retention/patients?doctorId=xxx&month=2026-05
 *
 * Retorna a "carteira" de pacientes de um profissional com indicadores de engajamento,
 * recorrência e risco de abandono — baseado inteiramente nos dados de Appointment e Package.
 *
 * Lifecycles (ordem de prioridade na UI):
 *   em_risco  → packageRemaining <= 1 OU absencesMonth >= 2 OU daysSinceLastSession > 21
 *   perdido   → daysSinceLastSession > 45 E packageRemaining > 0
 *   oscilando → absencesMonth >= 1 OU attendanceRate < 0.75 OU daysSinceLastSession > 10
 *   novo      → totalSessions <= 3
 *   engajado  → sessionsMonth >= 2 E attendanceRate >= 0.75 E daysSinceLastSession <= 10
 */

import express from 'express';
import mongoose from 'mongoose';
import moment from 'moment-timezone';
import { auth } from '../middleware/auth.js';
import Appointment from '../models/Appointment.js';
import Patient from '../models/Patient.js';
import Package from '../models/Package.js';
import Doctor from '../models/Doctor.js';

const router = express.Router();
const TIMEZONE = 'America/Sao_Paulo';

// Ordem de severidade para sorting (índice menor = mais urgente na tela)
const LIFECYCLE_SORT = ['em_risco', 'perdido', 'oscilando', 'novo', 'engajado'];

const COMPLETED_STATUSES = ['completed'];
const MISSED_STATUSES = ['missed'];
const FUTURE_STATUSES = ['scheduled', 'confirmed', 'pre_agendado'];

function calcLifecycle({ totalSessions, sessionsMonth, absencesMonth, attendanceRate, daysSinceLastSession, packageRemaining }) {
  // Novo: ainda em fase inicial — não qualifica outros critérios
  if (totalSessions <= 3) return 'novo';

  // Perdido: sumiu mas ainda tem pacote ativo (oportunidade de resgate)
  if (daysSinceLastSession !== null && daysSinceLastSession > 45 && packageRemaining > 0) return 'perdido';

  // Em risco: sinais concretos de abandono iminente
  if (
    packageRemaining <= 1 ||
    absencesMonth >= 2 ||
    (daysSinceLastSession !== null && daysSinceLastSession > 21)
  ) return 'em_risco';

  // Engajado: vem regularmente, presença alta, recente
  if (sessionsMonth >= 2 && attendanceRate >= 0.75 && daysSinceLastSession !== null && daysSinceLastSession <= 10) {
    return 'engajado';
  }

  // Default: oscilando — algo está fora do padrão ideal
  return 'oscilando';
}

/**
 * GET /api/v2/retention/patients
 *
 * Query params:
 *   doctorId  (ObjectId, opcional — sem filtro retorna visão global)
 *   month     (string "YYYY-MM", padrão: mês atual)
 */
router.get('/patients', auth, async (req, res) => {
  try {
    const { doctorId, month } = req.query;

    const now = moment().tz(TIMEZONE);
    const targetMoment = month
      ? moment.tz(`${month}-01`, 'YYYY-MM-DD', TIMEZONE)
      : now.clone().startOf('month');

    if (!targetMoment.isValid()) {
      return res.status(400).json({ error: 'Parâmetro month inválido. Use formato YYYY-MM.' });
    }

    const monthStart = targetMoment.clone().startOf('month').toDate();
    const monthEnd   = targetMoment.clone().endOf('month').toDate();
    const today      = now.toDate();

    // Janela histórica para totalSessions (12 meses evita carregar dados antigos demais)
    const historyStart = now.clone().subtract(12, 'months').startOf('day').toDate();

    // -------------------------------------------------------
    // Filtro por profissional (opcional)
    // -------------------------------------------------------
    const doctorOid = doctorId && mongoose.isValidObjectId(doctorId)
      ? new mongoose.Types.ObjectId(doctorId)
      : null;

    const doctorMatch = doctorOid ? { doctor: doctorOid } : {};

    // -------------------------------------------------------
    // 1. AGREGAÇÃO PRINCIPAL — mês corrente + histórico 12m
    // -------------------------------------------------------
    const [agg] = await Appointment.aggregate([
      {
        $facet: {
          // Comparecimentos e faltas do mês selecionado
          month: [
            {
              $match: {
                ...doctorMatch,
                patient: { $exists: true, $ne: null },
                date: { $gte: monthStart, $lte: monthEnd },
                operationalStatus: { $in: [...COMPLETED_STATUSES, ...MISSED_STATUSES] }
              }
            },
            {
              $group: {
                _id: '$patient',
                sessionsMonth: {
                  $sum: { $cond: [{ $in: ['$operationalStatus', COMPLETED_STATUSES] }, 1, 0] }
                },
                absencesMonth: {
                  $sum: { $cond: [{ $in: ['$operationalStatus', MISSED_STATUSES] }, 1, 0] }
                }
              }
            }
          ],

          // Histórico dos últimos 12 meses: total de sessões e última sessão
          history: [
            {
              $match: {
                ...doctorMatch,
                patient: { $exists: true, $ne: null },
                date: { $gte: historyStart },
                operationalStatus: { $in: COMPLETED_STATUSES }
              }
            },
            {
              $group: {
                _id: '$patient',
                totalSessions: { $sum: 1 },
                lastSessionEver: { $max: '$date' }
              }
            }
          ]
        }
      }
    ]);

    const { month: monthData, history: historyData } = agg;

    // Maps auxiliares
    const monthMap   = Object.fromEntries(monthData.map(m => [m._id?.toString(), m]));
    const historyMap = Object.fromEntries(historyData.map(h => [h._id?.toString(), h]));

    // União de IDs: pacientes do mês + pacientes com histórico (para pegar "perdidos")
    const patientIdSet = new Set([
      ...monthData.map(m => m._id?.toString()),
      ...historyData.map(h => h._id?.toString())
    ].filter(Boolean));

    if (patientIdSet.size === 0) {
      const doctorDoc = doctorOid ? await Doctor.findById(doctorOid, { fullName: 1 }).lean() : null;

      return res.json({
        doctor: doctorDoc ? { id: doctorId, name: doctorDoc.fullName } : null,
        period: { month: targetMoment.format('YYYY-MM'), start: monthStart, end: monthEnd },
        summary: { patients: 0, engajado: 0, oscilando: 0, em_risco: 0, perdido: 0, novo: 0, retentionRate: 0 },
        patients: []
      });
    }

    const patientOids = [...patientIdSet].map(id => new mongoose.Types.ObjectId(id));

    // -------------------------------------------------------
    // 2. QUERIES PARALELAS: nomes, próxima sessão, pacotes, profissional
    // -------------------------------------------------------
    const [patientDocs, nextAppointments, activePackages, doctorDoc] = await Promise.all([
      Patient.find({ _id: { $in: patientOids } }, { fullName: 1, phone: 1 }).lean(),

      Appointment.find(
        {
          patient: { $in: patientOids },
          ...(doctorOid ? { doctor: doctorOid } : {}),
          date: { $gt: today },
          operationalStatus: { $in: FUTURE_STATUSES }
        },
        { patient: 1, date: 1, time: 1 }
      ).sort({ date: 1 }).lean(),

      Package.find(
        {
          patient: { $in: patientOids },
          status: 'active'
        },
        { patient: 1, totalSessions: 1, sessionsDone: 1 }
      ).lean(),

      doctorOid ? Doctor.findById(doctorOid, { fullName: 1 }).lean() : Promise.resolve(null)
    ]);

    // Maps auxiliares
    const nameMap  = Object.fromEntries(patientDocs.map(p => [p._id.toString(), p.fullName]));
    const phoneMap = Object.fromEntries(patientDocs.map(p => [p._id.toString(), p.phone || '']));

    // Próxima sessão por paciente (já vem ordenado por date asc)
    const nextSessionMap = {};
    for (const appt of nextAppointments) {
      const pid = appt.patient?.toString();
      if (pid && !nextSessionMap[pid]) nextSessionMap[pid] = appt.date;
    }

    // Sessões restantes por paciente (maior pacote ativo)
    const packageMap = {};
    for (const pkg of activePackages) {
      const pid = pkg.patient?.toString();
      if (!pid) continue;
      const remaining = Math.max(0, (pkg.totalSessions || 0) - (pkg.sessionsDone || 0));
      if (packageMap[pid] === undefined || remaining > packageMap[pid]) {
        packageMap[pid] = remaining;
      }
    }

    // -------------------------------------------------------
    // 3. MONTAR RESULTADO POR PACIENTE
    // -------------------------------------------------------
    const patients = [];

    for (const pidStr of patientIdSet) {
      const m = monthMap[pidStr]   || { sessionsMonth: 0, absencesMonth: 0 };
      const h = historyMap[pidStr] || { totalSessions: 0, lastSessionEver: null };

      const sessionsMonth    = m.sessionsMonth;
      const absencesMonth    = m.absencesMonth;
      const totalSessions    = h.totalSessions;
      const lastSessionAt    = h.lastSessionEver || null;
      const nextSessionAt    = nextSessionMap[pidStr] || null;
      const packageRemaining = packageMap[pidStr] ?? 0;

      const attended        = sessionsMonth + absencesMonth;
      const attendanceRate  = attended > 0 ? sessionsMonth / attended : (totalSessions > 0 ? 1 : 0);
      const daysSinceLastSession = lastSessionAt
        ? now.diff(moment(lastSessionAt).tz(TIMEZONE), 'days')
        : null;

      const lifecycle = calcLifecycle({
        totalSessions,
        sessionsMonth,
        absencesMonth,
        attendanceRate,
        daysSinceLastSession,
        packageRemaining
      });

      const needsAttention =
        lifecycle === 'em_risco' ||
        lifecycle === 'perdido'  ||
        absencesMonth >= 2       ||
        (daysSinceLastSession !== null && daysSinceLastSession > 14);

      patients.push({
        patientId:           pidStr,
        patientName:         nameMap[pidStr] || 'Paciente',
        sessionsMonth,
        absencesMonth,
        totalSessions,
        attendanceRate:      Math.round(attendanceRate * 100) / 100,
        daysSinceLastSession,
        lastSessionAt,
        nextSessionAt,
        packageRemaining,
        lifecycle,
        needsAttention,
        phone: phoneMap[pidStr] || ''
      });
    }

    // Ordenação: mais urgente primeiro; dentro do grupo, mais dias sem vir primeiro
    patients.sort((a, b) => {
      const ai = LIFECYCLE_SORT.indexOf(a.lifecycle);
      const bi = LIFECYCLE_SORT.indexOf(b.lifecycle);
      if (ai !== bi) return ai - bi;
      return (b.daysSinceLastSession ?? 0) - (a.daysSinceLastSession ?? 0);
    });

    // -------------------------------------------------------
    // 4. SUMÁRIO DO PROFISSIONAL
    // -------------------------------------------------------
    const summary = { patients: patients.length, engajado: 0, oscilando: 0, em_risco: 0, perdido: 0, novo: 0 };
    for (const p of patients) summary[p.lifecycle] = (summary[p.lifecycle] || 0) + 1;

    const activeCount    = summary.engajado + summary.oscilando;
    summary.retentionRate = summary.patients > 0
      ? Math.round((activeCount / summary.patients) * 100)
      : 0;

    return res.json({
      doctor: doctorDoc
        ? { id: doctorId, name: doctorDoc.fullName }
        : (doctorId ? { id: doctorId } : null),
      period: {
        month: targetMoment.format('YYYY-MM'),
        start: monthStart,
        end:   monthEnd
      },
      summary,
      patients
    });

  } catch (err) {
    console.error('[retention.v2] /patients error:', err);
    return res.status(500).json({ error: 'Erro ao calcular retenção', detail: err.message });
  }
});

// ─── GET /slots ──────────────────────────────────────────────────────────────
/**
 * GET /api/v2/retention/slots?doctorId=xxx&days=30
 *
 * Grade semanal orientada por SLOT (terapeuta + dia + horário) — não por paciente.
 *
 * Conceito: o slot é a entidade. O paciente é o ocupante atual.
 *
 * Tipos de slot:
 *   fixo      → ≥ 6 sessões completadas na janela, taxa ≥ 75%
 *   semi_fixo → 3-5 sessões completadas
 *   novo      → ≤ 2 sessões completadas
 *   buraco    → tinha sessões no histórico, mas nenhuma nos últimos `days`
 *
 * Resposta inclui:
 *   - weekdays: slots organizados por dia (2=Seg … 6=Sex)
 *   - occupancyByDay: barra de ocupação por coluna (active/vacant/rate)
 *   - summary: totais globais
 */
router.get('/slots', auth, async (req, res) => {
  try {
    const { doctorId, days = '30' } = req.query;
    const recentDays  = Math.min(parseInt(days) || 30, 90);
    const historyDays = Math.max(recentDays * 2, 60); // Janela histórica para detectar buracos

    const now          = moment().tz(TIMEZONE);
    const recentStart  = now.clone().subtract(recentDays, 'days').startOf('day').toDate();
    const historyStart = now.clone().subtract(historyDays, 'days').startOf('day').toDate();
    const today        = now.toDate();

    const doctorOid   = doctorId && mongoose.isValidObjectId(doctorId)
      ? new mongoose.Types.ObjectId(doctorId)
      : null;
    const doctorMatch = doctorOid ? { doctor: doctorOid } : {};

    const baseMatch = {
      ...doctorMatch,
      patient: { $exists: true, $ne: null },
      date: { $gte: historyStart },
      operationalStatus: { $in: [...COMPLETED_STATUSES, ...MISSED_STATUSES] },
      time: { $exists: true, $ne: '' }
    };

    // ─── Agregações paralelas ────────────────────────────────────────────────
    const [aggResult, lastPatientAgg] = await Promise.all([
      // 1) Métricas por {weekday × time}
      Appointment.aggregate([
        { $match: baseMatch },
        {
          $addFields: {
            weekday:  { $dayOfWeek: { date: '$date', timezone: TIMEZONE } },
            isRecent: { $gte: ['$date', recentStart] }
          }
        },
        { $match: { weekday: { $gte: 2, $lte: 6 } } },
        { $sort: { date: 1 } },
        {
          $group: {
            _id: { weekday: '$weekday', time: '$time' },
            histCompleted: {
              $sum: { $cond: [{ $in: ['$operationalStatus', COMPLETED_STATUSES] }, 1, 0] }
            },
            histMissed: {
              $sum: { $cond: [{ $in: ['$operationalStatus', MISSED_STATUSES] }, 1, 0] }
            },
            recentCompleted: {
              $sum: {
                $cond: [{
                  $and: [
                    { $eq: ['$isRecent', true] },
                    { $in: ['$operationalStatus', COMPLETED_STATUSES] }
                  ]
                }, 1, 0]
              }
            },
            recentMissed: {
              $sum: {
                $cond: [{
                  $and: [
                    { $eq: ['$isRecent', true] },
                    { $in: ['$operationalStatus', MISSED_STATUSES] }
                  ]
                }, 1, 0]
              }
            },
            lastSessionAt: {
              $max: { $cond: [{ $in: ['$operationalStatus', COMPLETED_STATUSES] }, '$date', null] }
            },
            avgSessionValue: {
              $avg: {
                $cond: [{
                  $and: [
                    { $in: ['$operationalStatus', COMPLETED_STATUSES] },
                    { $gt: ['$sessionValue', 0] }
                  ]
                }, '$sessionValue', null]
              }
            }
          }
        }
      ]),

      // 2) Último paciente por slot + contagem + primeira data (continuidade)
      //    Agrupa (slot × paciente) primeiro → depois pega o mais recente por slot
      Appointment.aggregate([
        {
          $match: {
            ...doctorMatch,
            patient: { $exists: true, $ne: null },
            date: { $gte: historyStart },
            operationalStatus: { $in: COMPLETED_STATUSES },
            time: { $exists: true, $ne: '' }
          }
        },
        {
          $addFields: {
            weekday: { $dayOfWeek: { date: '$date', timezone: TIMEZONE } }
          }
        },
        { $match: { weekday: { $gte: 2, $lte: 6 } } },
        // Agrupa por (slot × paciente): conta sessões, primeira e última data
        {
          $group: {
            _id: { weekday: '$weekday', time: '$time', patient: '$patient' },
            patientCount: { $sum: 1 },
            firstDate:    { $min: '$date' },
            lastDate:     { $max: '$date' }
          }
        },
        // Ordena do mais recente para o mais antigo
        { $sort: { lastDate: -1 } },
        // Pega o paciente mais recente por slot e sua contagem pessoal
        {
          $group: {
            _id: { weekday: '$_id.weekday', time: '$_id.time' },
            lastPatientId:       { $first: '$_id.patient' },
            currentPatientCount: { $first: '$patientCount' },
            firstSessionAt:      { $first: '$firstDate' }
          }
        }
      ])
    ]);

    if (aggResult.length === 0) {
      const doctorDoc = doctorOid ? await Doctor.findById(doctorOid, { fullName: 1, specialty: 1 }).lean() : null;
      return res.json({
        doctor: doctorDoc ? { id: doctorId, name: doctorDoc.fullName, specialty: doctorDoc.specialty } : null,
        windowDays: recentDays,
        summary: { totalSlots: 0, activeSlots: 0, vacantSlots: 0, occupancyRate: 0 },
        occupancyByDay: Object.fromEntries([2,3,4,5,6].map(d => [d, { active: 0, vacant: 0, rate: 0, total: 0 }])),
        weekdays: { 2: [], 3: [], 4: [], 5: [], 6: [] }
      });
    }

    // Map: slotKey → { patientId, currentPatientCount, firstSessionAt }
    const lastPatientMap = {};
    for (const lp of lastPatientAgg) {
      lastPatientMap[`${lp._id.weekday}_${lp._id.time}`] = {
        patientId:           lp.lastPatientId?.toString(),
        currentPatientCount: lp.currentPatientCount || 0,
        firstSessionAt:      lp.firstSessionAt || null
      };
    }

    // Coletar todos os IDs de pacientes necessários
    const patientIdSet = new Set(
      Object.values(lastPatientMap).map(v => v.patientId).filter(Boolean)
    );
    const patientOids  = [...patientIdSet].map(id => new mongoose.Types.ObjectId(id));

    // ─── Queries paralelas: nomes, próxima sessão, pacotes, profissional ────
    const [patientDocs, nextAppts, activePackages, doctorDoc] = await Promise.all([
      patientOids.length > 0
        ? Patient.find({ _id: { $in: patientOids } }, { fullName: 1, phone: 1 }).lean()
        : Promise.resolve([]),

      patientOids.length > 0
        ? Appointment.find(
            {
              patient: { $in: patientOids },
              ...(doctorOid ? { doctor: doctorOid } : {}),
              date: { $gt: today },
              operationalStatus: { $in: FUTURE_STATUSES }
            },
            { patient: 1, date: 1, time: 1 }
          ).sort({ date: 1 }).lean()
        : Promise.resolve([]),

      patientOids.length > 0
        ? Package.find(
            { patient: { $in: patientOids }, status: 'active' },
            { patient: 1, totalSessions: 1, sessionsDone: 1 }
          ).lean()
        : Promise.resolve([]),

      doctorOid ? Doctor.findById(doctorOid, { fullName: 1, specialty: 1 }).lean() : Promise.resolve(null)
    ]);

    const nameMap  = Object.fromEntries(patientDocs.map(p => [p._id.toString(), p.fullName]));
    const phoneMap = Object.fromEntries(patientDocs.map(p => [p._id.toString(), p.phone || '']));

    const nextMap = {};
    for (const a of nextAppts) {
      const pid = a.patient?.toString();
      if (pid && !nextMap[pid]) nextMap[pid] = a.date;
    }

    const packageMap = {};
    for (const pkg of activePackages) {
      const pid = pkg.patient?.toString();
      if (!pid) continue;
      const rem = Math.max(0, (pkg.totalSessions || 0) - (pkg.sessionsDone || 0));
      if (packageMap[pid] === undefined || rem > packageMap[pid]) packageMap[pid] = rem;
    }

    // ─── Construir grade de slots ────────────────────────────────────────────
    const weekdays = { 2: [], 3: [], 4: [], 5: [], 6: [] };

    for (const row of aggResult) {
      const { weekday, time } = row._id;
      if (!weekdays[weekday]) continue;

      const slotKey            = `${weekday}_${time}`;
      const slotData           = lastPatientMap[slotKey] || {};
      const patientId          = slotData.patientId;
      const patientCount       = slotData.currentPatientCount || 0;
      const isVacant           = row.recentCompleted === 0 && row.histCompleted > 0;

      const histTotal      = row.histCompleted + row.histMissed;
      const attendanceRate = histTotal > 0 ? row.histCompleted / histTotal : 0;

      // Tipo legado (fixo/semi_fixo/novo/buraco)
      let slotType;
      if (isVacant)                                        slotType = 'buraco';
      else if (patientCount >= 6 && attendanceRate >= 0.75) slotType = 'fixo';
      else if (patientCount >= 3)                           slotType = 'semi_fixo';
      else                                                  slotType = 'novo';

      const lastSessionAt        = row.lastSessionAt || null;
      const daysSinceLastSession = lastSessionAt
        ? now.diff(moment(lastSessionAt).tz(TIMEZONE), 'days')
        : null;

      const packageRemaining = patientId ? (packageMap[patientId] ?? 0) : 0;
      const nextSessionAt    = patientId ? (nextMap[patientId] || null) : null;

      // ─── Continuidade clínica (em meses) ───
      const firstSessionAt = slotData.firstSessionAt || null;
      const continuityMonths = firstSessionAt && lastSessionAt
        ? Math.max(1, Math.round(now.diff(moment(firstSessionAt).tz(TIMEZONE), 'days') / 30))
        : 0;

      // ─── Score de estabilidade (0-100) ───
      let score = 50;
      // Recorrência passada
      if (patientCount >= 8) score += 30;
      else if (patientCount >= 4) score += 20;
      else if (patientCount >= 2) score += 10;
      // Frequência
      if (attendanceRate >= 0.85) score += 20;
      else if (attendanceRate >= 0.65) score += 10;
      // Próxima sessão marcada
      if (nextSessionAt) score += 25;
      // Faltas recentes
      if (row.recentMissed >= 2) score -= 15;
      else if (row.recentMissed >= 1) score -= 5;
      // Sem sessão futura (só se não é vazio)
      if (!isVacant && !nextSessionAt) score -= 20;
      // Dias sem atendimento
      if (daysSinceLastSession !== null && daysSinceLastSession > 14) score -= 15;
      // Slot vazio
      if (isVacant && daysSinceLastSession !== null && daysSinceLastSession <= 30) score -= 20;
      if (isVacant && daysSinceLastSession !== null && daysSinceLastSession > 60) score -= 30;
      if (isVacant && daysSinceLastSession !== null && daysSinceLastSession > 45) score -= 10;
      // Clamp
      score = Math.max(0, Math.min(100, Math.round(score)));

      // ─── Classificação de estabilidade ───
      let stability;
      if (isVacant && (row.histCompleted >= 4 || (daysSinceLastSession !== null && daysSinceLastSession <= 30))) {
        stability = 'risco';
      } else if (!isVacant && nextSessionAt && attendanceRate >= 0.75 && patientCount >= 4) {
        stability = 'estavel';
      } else if (!isVacant && patientCount < 3) {
        stability = 'novo';
      } else if (!isVacant && (!nextSessionAt || (daysSinceLastSession !== null && daysSinceLastSession > 10))) {
        stability = 'atencao';
      } else if (isVacant && row.histCompleted < 3) {
        stability = 'livre';
      } else {
        stability = 'atencao';
      }

      // ─── Tipo de vazio ───
      let vacantType = null;
      if (isVacant) {
        if (nextSessionAt) vacantType = 'temporario';
        else if (row.histCompleted >= 4 || (daysSinceLastSession !== null && daysSinceLastSession <= 30)) vacantType = 'critico';
        else vacantType = 'livre';
      }

      // ─── Motivo da classificação ───
      const reasons = [];
      if (isVacant) {
        if (nextSessionAt) reasons.push('Paciente ausente esta semana, mas tem próxima sessão agendada');
        else if (row.histCompleted >= 4) reasons.push(`Ocupado ${row.histCompleted}x nas últimas semanas, sem continuidade`);
        else reasons.push('Pouco uso histórico');
      } else {
        if (nextSessionAt) reasons.push('Próxima sessão confirmada');
        else reasons.push('Sem próxima sessão agendada');
        if (patientCount >= 4) reasons.push(`${patientCount} sessões neste horário`);
        if (attendanceRate >= 0.85) reasons.push(`Presença ${Math.round(attendanceRate * 100)}%`);
        else if (attendanceRate < 0.65) reasons.push(`Presença baixa (${Math.round(attendanceRate * 100)}%)`);
      }
      if (daysSinceLastSession !== null) {
        reasons.push(`Última sessão há ${daysSinceLastSession} dias`);
      }
      if (row.recentMissed >= 2) reasons.push(`${row.recentMissed} faltas recentes`);

      weekdays[weekday].push({
        weekday,
        time,
        type:    slotType,
        isVacant,

        currentPatientId:    !isVacant ? patientId       : null,
        currentPatientName:  !isVacant ? (nameMap[patientId]  || null) : null,
        currentPatientPhone: !isVacant ? (phoneMap[patientId] || '') : '',
        lastPatientId:       isVacant  ? patientId       : null,
        lastPatientName:     isVacant  ? (nameMap[patientId]  || null) : null,

        recurrenceCount:  patientCount,
        slotTotalSessions: row.histCompleted,
        recentCompleted:  row.recentCompleted,
        recentMissed:     row.recentMissed || 0,
        attendanceRate:   Math.round(attendanceRate * 100) / 100,

        packageRemaining,
        nextSessionAt,
        daysSinceLastSession,
        daysSinceVacant: isVacant ? daysSinceLastSession : null,
        avgSessionValue: Math.round(row.avgSessionValue || 0),
        continuityMonths,
        stabilityScore: score,
        stability,
        vacantType,
        stabilityReason: reasons.join(' · '),

        needsAttention:
          isVacant ||
          (daysSinceLastSession !== null && daysSinceLastSession > 14) ||
          row.recentMissed >= 2
      });
    }

    // Ordenar por horário
    for (const slots of Object.values(weekdays)) {
      slots.sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
    }

    // ─── Sumário de ocupação + estabilidade ──────────────────────────────────
    const occupancyByDay = {};
    let totalSlots = 0, activeSlots = 0, vacantSlots = 0;
    let stableSlots = 0, atRiskSlots = 0, attentionSlots = 0, newSlots = 0, criticalSlots = 0;
    let potentialLossMonthly = 0;

    for (const [wd, slots] of Object.entries(weekdays)) {
      const active = slots.filter(s => !s.isVacant).length;
      const vacant = slots.filter(s => s.isVacant).length;
      const total  = slots.length;
      occupancyByDay[wd] = { active, vacant, total, rate: total > 0 ? Math.round((active / total) * 100) : 0 };
      totalSlots  += total;
      activeSlots += active;
      vacantSlots += vacant;

      for (const s of slots) {
        if (s.stability === 'estavel') stableSlots++;
        else if (s.stability === 'atencao') attentionSlots++;
        else if (s.stability === 'risco') atRiskSlots++;
        else if (s.stability === 'novo') newSlots++;
        if (s.vacantType === 'critico') criticalSlots++;
        if ((s.stability === 'risco' || s.vacantType === 'critico') && s.avgSessionValue > 0) {
          potentialLossMonthly += s.avgSessionValue * 4;
        }
      }
    }

    const recurrentSlots = totalSlots - newSlots;

    return res.json({
      doctor:     doctorDoc ? { id: doctorId, name: doctorDoc.fullName, specialty: doctorDoc.specialty } : null,
      windowDays: recentDays,
      summary: {
        totalSlots,
        activeSlots,
        vacantSlots,
        occupancyRate: totalSlots > 0 ? Math.round((activeSlots / totalSlots) * 100) : 0,
        stableSlots,
        attentionSlots,
        atRiskSlots,
        newSlots,
        criticalSlots,
        potentialLossMonthly: Math.round(potentialLossMonthly),
        stabilityRate: recurrentSlots > 0 ? Math.round((stableSlots / recurrentSlots) * 100) : 0
      },
      occupancyByDay,
      weekdays
    });

  } catch (err) {
    console.error('[retention.v2] /slots error:', err);
    return res.status(500).json({ error: 'Erro ao calcular grade de slots', detail: err.message });
  }
});

// ─── GET /weekly ─────────────────────────────────────────────────────────────
/**
 * GET /api/v2/retention/weekly?doctorId=xxx&weeks=12
 *
 * Retorna a grade semanal de recorrência de uma terapeuta:
 *   - Agrupa pacientes por {paciente × dia da semana}
 *   - Calcula horário preferido, frequência e lifecycle semanal
 *   - Resposta organizada em colunas (weekday 2=Seg … 6=Sex)
 *
 * Lifecycles:
 *   fixo      → recurrenceCount ≥ 4 E attendanceRate ≥ 0.75 E daysSince ≤ 14
 *   oscilando → recurrenceCount ≥ 2 (não atingiu critérios de fixo)
 *   sumiu     → daysSinceLastSession > 21 E total > 3
 *   novo      → total sessões no período ≤ 3
 */
router.get('/weekly', auth, async (req, res) => {
  try {
    const { doctorId, days = '30' } = req.query;
    const daysBack = Math.min(parseInt(days) || 30, 180);

    const now = moment().tz(TIMEZONE);
    const windowStart = now.clone().subtract(daysBack, 'days').startOf('day').toDate();
    const today       = now.toDate();

    const doctorOid = doctorId && mongoose.isValidObjectId(doctorId)
      ? new mongoose.Types.ObjectId(doctorId)
      : null;
    const doctorMatch = doctorOid ? { doctor: doctorOid } : {};

    // -------------------------------------------------------
    // 1. AGREGAÇÃO: {patient × weekday} na janela histórica
    // -------------------------------------------------------
    const aggResult = await Appointment.aggregate([
      {
        $match: {
          ...doctorMatch,
          patient: { $exists: true, $ne: null },
          date: { $gte: windowStart },
          operationalStatus: { $in: [...COMPLETED_STATUSES, ...MISSED_STATUSES] }
        }
      },
      {
        $addFields: {
          weekday: { $dayOfWeek: { date: '$date', timezone: TIMEZONE } }
        }
      },
      // Apenas dias úteis (2=Seg … 6=Sex)
      { $match: { weekday: { $gte: 2, $lte: 6 } } },
      {
        $group: {
          _id:             { patient: '$patient', weekday: '$weekday' },
          recurrenceCount: { $sum: { $cond: [{ $in: ['$operationalStatus', COMPLETED_STATUSES] }, 1, 0] } },
          absenceCount:    { $sum: { $cond: [{ $in: ['$operationalStatus', MISSED_STATUSES] }, 1, 0] } },
          times:           { $push: { $cond: [{ $in: ['$operationalStatus', COMPLETED_STATUSES] }, '$time', null] } },
          lastSessionAt:   { $max: { $cond: [{ $in: ['$operationalStatus', COMPLETED_STATUSES] }, '$date', null] } }
        }
      }
    ]);

    if (aggResult.length === 0) {
      const doctorDoc = doctorOid ? await Doctor.findById(doctorOid, { fullName: 1 }).lean() : null;
      return res.json({
        doctor: doctorDoc ? { id: doctorId, name: doctorDoc.fullName } : null,
        windowDays: daysBack,
        weekdays: { 2: [], 3: [], 4: [], 5: [], 6: [] }
      });
    }

    const patientIdSet = new Set(aggResult.map(r => r._id.patient?.toString()).filter(Boolean));
    const patientOids  = [...patientIdSet].map(id => new mongoose.Types.ObjectId(id));

    // -------------------------------------------------------
    // 2. QUERIES PARALELAS
    // -------------------------------------------------------
    const [patientDocs, nextAppts, activePackages, doctorDoc] = await Promise.all([
      Patient.find({ _id: { $in: patientOids } }, { fullName: 1, phone: 1 }).lean(),

      Appointment.find(
        {
          patient: { $in: patientOids },
          ...(doctorOid ? { doctor: doctorOid } : {}),
          date: { $gt: today },
          operationalStatus: { $in: FUTURE_STATUSES }
        },
        { patient: 1, date: 1, time: 1 }
      ).sort({ date: 1 }).lean(),

      Package.find(
        { patient: { $in: patientOids }, status: 'active' },
        { patient: 1, totalSessions: 1, sessionsDone: 1 }
      ).lean(),

      doctorOid ? Doctor.findById(doctorOid, { fullName: 1 }).lean() : Promise.resolve(null)
    ]);

    const nameMap  = Object.fromEntries(patientDocs.map(p => [p._id.toString(), p.fullName]));
    const phoneMap = Object.fromEntries(patientDocs.map(p => [p._id.toString(), p.phone || '']));

    const nextMap = {};
    for (const a of nextAppts) {
      const pid = a.patient?.toString();
      if (pid && !nextMap[pid]) nextMap[pid] = a.date;
    }

    const packageMap = {};
    for (const pkg of activePackages) {
      const pid = pkg.patient?.toString();
      if (!pid) continue;
      const rem = Math.max(0, (pkg.totalSessions || 0) - (pkg.sessionsDone || 0));
      if (packageMap[pid] === undefined || rem > packageMap[pid]) packageMap[pid] = rem;
    }

    // -------------------------------------------------------
    // 3. HELPERS
    // -------------------------------------------------------
    function mostCommonTime(times) {
      const valid = times.filter(t => t != null && t !== '');
      if (!valid.length) return '';
      const freq = {};
      let maxCount = 0, mode = valid[0];
      for (const t of valid) {
        freq[t] = (freq[t] || 0) + 1;
        if (freq[t] > maxCount) { maxCount = freq[t]; mode = t; }
      }
      return mode;
    }

    function calcWeeklyLifecycle({ recurrenceCount, attendanceRate, daysSinceLastSession, totalInWindow }) {
      if (totalInWindow <= 3)                                              return 'novo';
      if (daysSinceLastSession !== null && daysSinceLastSession > 21)     return 'sumiu';
      if (recurrenceCount >= 4 && attendanceRate >= 0.75
          && daysSinceLastSession !== null && daysSinceLastSession <= 14) return 'fixo';
      return 'oscilando';
    }

    // -------------------------------------------------------
    // 4. MONTAR GRADE SEMANAL
    // -------------------------------------------------------
    const weekdays = { 2: [], 3: [], 4: [], 5: [], 6: [] };

    for (const row of aggResult) {
      const pidStr  = row._id.patient?.toString();
      const weekday = row._id.weekday;
      if (!pidStr || !weekdays[weekday]) continue;

      const preferredTime     = mostCommonTime(row.times);
      const lastSessionAt     = row.lastSessionAt || null;
      const nextSessionAt     = nextMap[pidStr] || null;
      const packageRemaining  = packageMap[pidStr] ?? 0;
      const totalInWindow     = row.recurrenceCount + row.absenceCount;
      const attended          = row.recurrenceCount;
      const attendanceRate    = totalInWindow > 0 ? attended / totalInWindow : 0;

      const daysSinceLastSession = lastSessionAt
        ? now.diff(moment(lastSessionAt).tz(TIMEZONE), 'days')
        : null;

      const lifecycle = calcWeeklyLifecycle({
        recurrenceCount: row.recurrenceCount,
        attendanceRate,
        daysSinceLastSession,
        totalInWindow
      });

      const needsAttention =
        lifecycle === 'sumiu' ||
        row.absenceCount >= 2 ||
        (daysSinceLastSession !== null && daysSinceLastSession > 14);

      weekdays[weekday].push({
        patientId:          pidStr,
        patientName:        nameMap[pidStr] || 'Paciente',
        phone:              phoneMap[pidStr] || '',
        weekday,
        preferredTime,
        recurrenceCount:    row.recurrenceCount,
        absenceCount:       row.absenceCount,
        totalInWindow,
        attendanceRate:     Math.round(attendanceRate * 100) / 100,
        daysSinceLastSession,
        lastSessionAt,
        nextSessionAt,
        packageRemaining,
        lifecycle,
        needsAttention
      });
    }

    // Ordena cada dia por horário preferido
    for (const day of Object.values(weekdays)) {
      day.sort((a, b) => (a.preferredTime || '99:99').localeCompare(b.preferredTime || '99:99'));
    }

    return res.json({
      doctor:     doctorDoc ? { id: doctorId, name: doctorDoc.fullName } : null,
      windowDays: daysBack,
      weekdays
    });

  } catch (err) {
    console.error('[retention.v2] /weekly error:', err);
    return res.status(500).json({ error: 'Erro ao calcular grade semanal', detail: err.message });
  }
});

export default router;
