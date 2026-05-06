import mongoose from 'mongoose';
import ShadowPattern from '../models/ShadowPattern.js';
import Appointment from '../../../models/Appointment.js';

const LOOKBACK_DAYS = 30;
const MIN_OCCURRENCES = 2;
const ON_THE_FLY_LIMIT = 50;

function getDayKeyFromYMD(dateYMD) {
  const dow = new Date(`${dateYMD}T12:00:00-03:00`).getDay();
  return dow;
}

function normalizeTimeHHmm(value) {
  if (!value) return null;
  const t = String(value).trim();
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = String(m[1]).padStart(2, '0');
  const mm = m[2];
  const h = Number(hh);
  const mi = Number(mm);
  if (Number.isNaN(h) || Number.isNaN(mi) || h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return `${hh}:${mm}`;
}

function calculateConfidence(occurrences, lastDates) {
  // 1. Occurrence score: quanto mais vezes, mais confiante (satura em 4)
  const occurrenceScore = Math.min(1, occurrences / 4);

  // 2. Recency score: última sessão recente = mais confiante
  let recencyScore = 0.1;
  if (lastDates && lastDates.length > 0) {
    const lastDate = new Date(lastDates[0]);
    const daysAgo = (Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysAgo <= 7) recencyScore = 1.0;
    else if (daysAgo <= 14) recencyScore = 0.7;
    else if (daysAgo <= 21) recencyScore = 0.5;
    else if (daysAgo <= 30) recencyScore = 0.3;
    else recencyScore = 0.1;
  }

  // 3. Consistency score: horário idêntico (garantido pelo agrupamento)
  const consistencyScore = 1.0;

  const raw = (occurrenceScore * 0.5) + (recencyScore * 0.3) + (consistencyScore * 0.2);
  return Math.min(0.99, Math.round(raw * 100) / 100);
}

function groupAppointmentsToPatterns(history, doctorObjectId) {
  const groups = new Map();

  for (const app of history) {
    if (!app.patient || !app.date || !app.time) continue;

    const dayOfWeek = new Date(app.date).getDay();
    const time = normalizeTimeHHmm(app.time);
    if (time === null) continue;

    const key = `${app.patient.toString()}-${dayOfWeek}-${time}`;
    if (!groups.has(key)) {
      groups.set(key, {
        patientId: app.patient.toString(),
        doctorId: doctorObjectId.toString(),
        dayOfWeek,
        time,
        dates: []
      });
    }
    groups.get(key).dates.push(new Date(app.date));
  }

  const patterns = [];
  for (const group of groups.values()) {
    if (group.dates.length < MIN_OCCURRENCES) continue;

    const uniqueDates = Array.from(new Set(group.dates.map(d => d.toISOString().split('T')[0])))
      .map(d => new Date(d))
      .sort((a, b) => b - a);

    const occurrences = uniqueDates.length;
    const confidence = calculateConfidence(occurrences, uniqueDates);

    patterns.push({
      patientId: group.patientId,
      doctorId: group.doctorId,
      dayOfWeek: group.dayOfWeek,
      time: group.time,
      occurrences,
      lastDates: uniqueDates.slice(0, 10),
      confidence,
      lastAnalyzedAt: new Date(),
      validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    });
  }

  return patterns;
}

export class ShadowPatternService {
  /**
   * Analisa o histórico de agendamentos de um médico nos últimos N dias,
   * detecta padrões de recorrência e persiste/atualiza na coleção ShadowPattern (cache).
   */
  static async analyzeAndCacheForDoctor(doctorId) {
    if (!mongoose.Types.ObjectId.isValid(String(doctorId))) return [];

    const doctorObjectId = new mongoose.Types.ObjectId(String(doctorId));
    const since = new Date();
    since.setDate(since.getDate() - LOOKBACK_DAYS);
    since.setHours(0, 0, 0, 0);

    const history = await Appointment.find({
      doctor: doctorObjectId,
      date: { $gte: since },
      operationalStatus: { $nin: ['canceled', 'missed', 'pre_agendado'] }
    })
      .select('patient date time')
      .lean();

    const patterns = groupAppointmentsToPatterns(history, doctorObjectId);
    const bulkOps = patterns.map(p => ({
      updateOne: {
        filter: {
          patientId: p.patientId,
          doctorId: p.doctorId,
          dayOfWeek: p.dayOfWeek,
          time: p.time
        },
        update: { $set: p },
        upsert: true
      }
    }));

    if (bulkOps.length > 0) {
      await ShadowPattern.bulkWrite(bulkOps);
    }

    return bulkOps.length;
  }

  /**
   * Fallback leve: detecta padrões on-the-fly sem cache.
   * Usado quando o cache está vazio ou expirado.
   * Retorna patterns em memória (não persiste no banco para ser rápido).
   */
  static async detectOnTheFly(doctorId, dateYMD, limit = ON_THE_FLY_LIMIT) {
    if (!mongoose.Types.ObjectId.isValid(String(doctorId))) return new Map();

    const doctorObjectId = new mongoose.Types.ObjectId(String(doctorId));
    const since = new Date();
    since.setDate(since.getDate() - LOOKBACK_DAYS);
    since.setHours(0, 0, 0, 0);

    const history = await Appointment.find({
      doctor: doctorObjectId,
      date: { $gte: since },
      operationalStatus: { $nin: ['canceled', 'missed', 'pre_agendado'] }
    })
      .select('patient date time')
      .sort({ date: -1 })
      .limit(limit)
      .lean();

    const patterns = groupAppointmentsToPatterns(history, doctorObjectId);

    // Popula nomes dos pacientes (batch)
    const patientIds = [...new Set(patterns.map(p => p.patientId))];
    const patients = await mongoose.model('Patient').find({ _id: { $in: patientIds } }).select('fullName').lean();
    const patientMap = new Map(patients.map(p => [p._id.toString(), p.fullName]));

    const byTime = new Map();
    for (const p of patterns) {
      if (!byTime.has(p.time)) byTime.set(p.time, []);
      byTime.get(p.time).push({
        patientId: p.patientId,
        patientName: patientMap.get(p.patientId) || 'Paciente',
        occurrences: p.occurrences,
        lastDates: p.lastDates,
        confidence: p.confidence,
        lastAnalyzedAt: p.lastAnalyzedAt
      });
    }

    return byTime;
  }

  /**
   * Busca TODOS os padrões shadow válidos para um médico em um determinado dia da semana.
   * Se cache vazio, faz fallback on-the-fly.
   */
  static async findPatternsForDoctorDay(doctorId, dateYMD) {
    if (!mongoose.Types.ObjectId.isValid(String(doctorId))) return new Map();

    const doctorObjectId = new mongoose.Types.ObjectId(String(doctorId));
    const dayOfWeek = getDayKeyFromYMD(dateYMD);

    let patterns = await ShadowPattern.find({
      doctorId: doctorObjectId,
      dayOfWeek,
      validUntil: { $gte: new Date() }
    })
      .populate('patientId', 'fullName')
      .lean();

    // 🔥 Fallback: se cache vazio, detecta on-the-fly
    if (!patterns || patterns.length === 0) {
      return this.detectOnTheFly(doctorId, dateYMD);
    }

    const byTime = new Map();
    for (const p of patterns) {
      const t = normalizeTimeHHmm(p.time);
      if (!t) continue;
      if (!byTime.has(t)) byTime.set(t, []);
      byTime.get(t).push({
        patientId: p.patientId?._id?.toString() || p.patientId.toString(),
        patientName: p.patientId?.fullName || 'Paciente',
        occurrences: p.occurrences,
        lastDates: p.lastDates,
        confidence: p.confidence,
        lastAnalyzedAt: p.lastAnalyzedAt
      });
    }

    return byTime;
  }

  /**
   * Busca padrões shadow válidos para um determinado médico, data e horário.
   */
  static async findPatternsForSlot(doctorId, dateYMD, timeStr) {
    if (!mongoose.Types.ObjectId.isValid(String(doctorId))) return [];

    const doctorObjectId = new mongoose.Types.ObjectId(String(doctorId));
    const dayOfWeek = getDayKeyFromYMD(dateYMD);
    const time = normalizeTimeHHmm(timeStr);
    if (time === null) return [];

    const patterns = await ShadowPattern.find({
      doctorId: doctorObjectId,
      dayOfWeek,
      time,
      validUntil: { $gte: new Date() }
    })
      .populate('patientId', 'fullName')
      .lean();

    if (!patterns || patterns.length === 0) {
      // Fallback on-the-fly para slot específico
      const allPatterns = await this.detectOnTheFly(doctorId, dateYMD);
      return allPatterns.get(time) || [];
    }

    return patterns.map(p => ({
      patientId: p.patientId?._id?.toString() || p.patientId.toString(),
      patientName: p.patientId?.fullName || 'Paciente',
      occurrences: p.occurrences,
      lastDates: p.lastDates,
      confidence: p.confidence,
      lastAnalyzedAt: p.lastAnalyzedAt
    }));
  }
}
