import mongoose from "mongoose";
import { NON_BLOCKING_OPERATIONAL_STATUSES } from "../constants/appointmentStatus.js";
import Appointment from "../models/Appointment.js";
import Doctor from "../models/Doctor.js";
import Session from "../models/Session.js";
import { isNationalHoliday, getHolidayName, isTimeBlockedByHoliday } from "../config/feriadosBR-dynamic.js";
import { buildDayRange, buildDateTime } from "../utils/datetime.js";
import { ShadowPatternService } from "../domains/appointment/services/ShadowPatternService.js";
import { ShadowLockService } from "../domains/appointment/services/ShadowLockService.js";

/**
 * ✅ SAFE AVAILABILITY + CONFLICT CHECK (drop-in)
 * - ObjectId validation -> 400 instead of 500
 * - time normalization to HH:mm (handles "8:00" vs "08:00")
 * - business hours filter 08:00–18:00 (adjust constants if needed)
 * - dedupe + sort doctor's daily availability
 *
 * Exports:
 *   - checkAppointmentConflicts (middleware)
 *   - getAvailableTimeSlots (GET /available-slots?doctorId=...&date=YYYY-MM-DD)
 */

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const BUSINESS_START = "08:00";
const BUSINESS_END = "18:00";

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(String(id || ""));
}

function toObjectId(id) {
  return new mongoose.Types.ObjectId(String(id));
}

function normalizeTimeHHmm(value) {
  if (!value) return null;
  const t = String(value).trim();

  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;

  const hh = String(m[1]).padStart(2, "0");
  const mm = m[2];

  const h = Number(hh);
  const mi = Number(mm);
  if (Number.isNaN(h) || Number.isNaN(mi) || h < 0 || h > 23 || mi < 0 || mi > 59) return null;

  return `${hh}:${mm}`;
}

function inBusinessHoursHHmm(t) {
  return t >= BUSINESS_START && t <= BUSINESS_END;
}

function getDayKeyFromYMD(dateYMD) {
  // SP midday to avoid timezone boundary issues
  const dow = new Date(`${dateYMD}T12:00:00-03:00`).getDay();
  return DAYS[dow];
}

// ======================================================
// ✅ MIDDLEWARE: conflicts (doctor + patient)
// ======================================================
// Extrai ID de campo que pode ser string, ObjectId ou objeto populado
function extractId(field) {
  if (!field) return undefined;
  if (typeof field === 'string') return field;
  if (typeof field === 'object') return field._id?.toString?.() || field.id?.toString?.() || String(field);
  return String(field);
}

export const checkAppointmentConflicts = async (req, res, next) => {
  const { date, time, operationalStatus, isNewPatient, isJointSession } = req.body;
  const appointmentId = req.params?.id;

  // Aceita tanto doctorId quanto doctor (nome do campo no modelo Mongoose)
  const doctorId = req.body.doctorId || extractId(req.body.doctor);
  // Aceita tanto patientId quanto patient
  let patientId = req.body.patientId || extractId(req.body.patient);

  // 🔥 Pré-agendamentos podem não ter patientId (paciente ainda não cadastrado)
  const isPreAgendamento = operationalStatus === 'pre_agendado' || isNewPatient === true;

  // Normaliza horário antes da lookup (necessário para comparação de slot)
  const timeHHmm = normalizeTimeHHmm(time);

  // Para edições (PUT /:id): lê existente para (1) patientId e (2) skip se slot não mudou
  if (appointmentId && isValidObjectId(appointmentId)) {
    try {
      const existing = await Appointment.findById(appointmentId).select('patient date time doctor').lean();
      if (existing) {
        if (!patientId && !isPreAgendamento && existing.patient) {
          patientId = existing.patient.toString();
        }
        // Se data, hora E médico não mudaram, o appointment já ocupa o slot — sem conflito novo
        const existingDateStr = existing.date
          ? new Date(existing.date).toISOString().substring(0, 10)
          : '';
        const existingTimeNorm = normalizeTimeHHmm(existing.time) || '';
        const existingDoctorId = existing.doctor?.toString() || '';
        const doctorUnchanged = !doctorId || existingDoctorId === doctorId;
        if (date && timeHHmm && existingDateStr === date && existingTimeNorm === timeHHmm && doctorUnchanged) {
          req.body.time = timeHHmm;
          return next();
        }
      }
    } catch (_) { /* non-blocking */ }
  }

  if (!doctorId || (!isPreAgendamento && !patientId) || !date || !time) {
    return res.status(400).json({
      error: "Dados incompletos para verificação de conflitos",
      requiredFields: {
        doctorId: !doctorId ? "Campo obrigatório" : "OK",
        patientId: (!isPreAgendamento && !patientId) ? "Campo obrigatório" : "OK",
        date: !date ? "Campo obrigatório" : "OK",
        time: !time ? "Campo obrigatório" : "OK",
      },
    });
  }

  if (!isValidObjectId(doctorId) || (!isPreAgendamento && !isValidObjectId(patientId))) {
    return res.status(400).json({
      error: "IDs inválidos",
      details: {
        doctorId: isValidObjectId(doctorId) ? "OK" : "ObjectId inválido",
        patientId: (!isPreAgendamento && !isValidObjectId(patientId)) ? "ObjectId inválido" : "OK",
      },
    });
  }

  if (appointmentId && !isValidObjectId(appointmentId)) {
    return res.status(400).json({
      error: "appointmentId inválido na URL",
      details: { appointmentId },
    });
  }

  if (!timeHHmm) {
    return res.status(400).json({
      error: "Formato de horário inválido",
      expected: "HH:mm (ex: 08:00)",
      received: time,
    });
  }

  try {
    const doctorObjectId = toObjectId(doctorId);
    const patientObjectId = patientId && !isPreAgendamento ? toObjectId(patientId) : null;
    const excludeSelf = appointmentId ? { _id: { $ne: toObjectId(appointmentId) } } : {};
    
    // 🆕 NOVO: Duração do novo agendamento (padrão 40 min)
    const newDuration = parseInt(req.body.duration) || 40;
    const newStartMinutes = timeToMinutes(timeHHmm);
    const newEndMinutes = newStartMinutes + newDuration;

    // 🚨 FIX: Usar helper padronizado para range de busca (timezone-safe)
    const dayRange = buildDayRange(date);

    // 🟢 SINGLE SOURCE OF TRUTH para ocupação do médico
    const occupancyData = await fetchOccupancyData(doctorId, date);
    const doctorOccupancy = getSlotOccupancy({
      time,
      duration: newDuration,
      date,
      occupancyData,
      excludeAppointmentId: appointmentId
    });

    if (doctorOccupancy.occupied) {
      const metadata = doctorOccupancy.metadata || {};
      console.log(
        `[checkAppointmentConflicts] CONFLITO MÉDICO: Novo ${timeHHmm}-${newEndMinutes}min` +
        ` | _id=${metadata._id} reason=${doctorOccupancy.reason} paciente="${metadata.patient?.fullName || '?'}`
      );
    }

    // 🆕 NOVO: Verificar sobreposição de intervalos para o paciente (fonte separada)
    const patientQueries = patientObjectId
      ? [
          Appointment.find({
            patient: patientObjectId,
            date: dayRange,
            operationalStatus: { $nin: NON_BLOCKING_OPERATIONAL_STATUSES },
            ...excludeSelf,
          })
            .select("time duration doctor operationalStatus _id")
            .populate("doctor", "fullName")
            .lean(),
          Session.find({
            patient: patientObjectId,
            date: dayRange,
            status: { $nin: ['canceled'] },
          })
            .select("time doctor")
            .populate("doctor", "fullName")
            .lean()
        ]
      : [Promise.resolve([]), Promise.resolve([])];

    const [patientAppointments, patientSessions] = await Promise.all(patientQueries);
    const allPatientSlots = [...patientAppointments, ...patientSessions];

    // 🆕 NOVO: Verificar sobreposição de intervalos para o paciente
    const patientConflict = allPatientSlots.find((appt) => {
      const apptTime = normalizeTimeHHmm(appt.time);
      if (!apptTime) return false;
      
      const apptDuration = appt.duration || 40;
      const apptStart = timeToMinutes(apptTime);
      const apptEnd = apptStart + apptDuration;
      
      const overlaps = newStartMinutes < apptEnd && newEndMinutes > apptStart;
      
      if (overlaps) {
        console.log(`[checkAppointmentConflicts] CONFLITO PACIENTE: Novo ${timeHHmm}-${newEndMinutes} sobrepõe existente ${apptTime}-${apptEnd}`);
      }
      
      return overlaps;
    });

    // Sessão Conjunta: mesmo profissional pode ter dois pacientes no mesmo horário
    if (doctorOccupancy.occupied && !isJointSession) {
      const metadata = doctorOccupancy.metadata || {};
      return res.status(409).json({
        error: "Conflito de agenda médica",
        message: "O médico já possui um compromisso neste horário",
        conflict: {
          appointmentId: metadata._id,
          patientName: metadata.patient?.fullName || "Nome não disponível",
          existingAppointment: metadata,
        },
        suggestion: "Por favor, escolha outro horário ou médico",
      });
    }

    if (patientConflict) {
      return res.status(409).json({
        error: "Conflito de agenda do paciente",
        message: "O paciente já possui um compromisso neste horário",
        conflict: {
          appointmentId: patientConflict._id,
          doctorName: patientConflict.doctor?.fullName || "Nome não disponível",
          existingAppointment: patientConflict,
        },
        suggestion: "Por favor, escolha outro horário ou paciente",
      });
    }

    // normalize downstream
    req.body.time = timeHHmm;

    return next();
  } catch (error) {
    console.error("Erro detalhado na verificação de conflitos:", {
      error: error.message,
      stack: error.stack,
      requestBody: req.body,
      params: req.params,
    });

    return res.status(500).json({
      error: "Erro interno na verificação de conflitos",
      details:
        process.env.NODE_ENV === "development"
          ? { message: error.message, stack: error.stack }
          : undefined,
    });
  }
};

// ======================================================
// 🔧 HELPERS: Cálculo de intervalos de tempo
// ======================================================

/**
 * Converte "HH:mm" para minutos desde meia-noite
 */
function timeToMinutes(timeStr) {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * Verifica se dois intervalos de tempo se sobrepõem
 * slotStart/slotEnd: intervalo do slot disponível
 * apptStart/apptEnd: intervalo do agendamento existente
 */
function intervalsOverlap(slotStart, slotEnd, apptStart, apptEnd) {
  return slotStart < apptEnd && slotEnd > apptStart;
}

/**
 * Verifica se um agendamento ocupa um slot
 * Considerando duração padrão de 40 minutos
 */
function appointmentBlocksSlot(slotTime, appointmentTime, durationMinutes = 40) {
  const slotStart = timeToMinutes(slotTime);
  const slotEnd = slotStart + durationMinutes;
  
  const apptStart = timeToMinutes(appointmentTime);
  const apptEnd = apptStart + durationMinutes;
  
  return intervalsOverlap(slotStart, slotEnd, apptStart, apptEnd);
}

// ======================================================
// 🟢 SINGLE SOURCE OF TRUTH: ocupação de um horário
// ======================================================

/**
 * Busca todos os dados de ocupação de um médico em um dia.
 * Usado por slots e conflict check para garantir regras idênticas.
 */
async function fetchOccupancyData(doctorId, date) {
  const doctorObjectId = toObjectId(doctorId);
  const dayRange = buildDayRange(date);

  const doctor = await Doctor.findById(doctorId).select('fullName').lean();
  const doctorName = doctor?.fullName || '';

  const [
    doctorAppointments,
    preAgendamentos,
    packageSessions,
    rawShadowLocks
  ] = await Promise.all([
    Appointment.find({
      doctor: doctorObjectId,
      date: dayRange,
      operationalStatus: { $nin: NON_BLOCKING_OPERATIONAL_STATUSES },
    })
      .select('date time duration startDateTime endDateTime patient operationalStatus _id')
      .populate('patient', 'fullName')
      .lean(),

    Appointment.find({
      date: dayRange,
      operationalStatus: 'pre_agendado',
      $or: [
        { doctor: doctorObjectId },
        ...(doctorName ? [{ professionalName: { $regex: new RegExp(doctorName, 'i') } }] : [])
      ]
    })
      .select('date time duration startDateTime endDateTime patient operationalStatus _id')
      .populate('patient', 'fullName')
      .lean(),

    Session.find({
      doctor: doctorObjectId,
      date: dayRange,
      status: { $nin: ['canceled'] },
    })
      .select('date time duration startDateTime endDateTime patient _id')
      .populate('patient', 'fullName')
      .lean(),

    ShadowLockService.findActiveLocksForDoctorDay(doctorId, date).catch(err => {
      console.error('[fetchOccupancyData] Erro ao buscar shadow locks:', err.message);
      return new Map();
    })
  ]);

  const lockMap = rawShadowLocks instanceof Map ? rawShadowLocks : new Map();

  // Converte documentos em intervalos Date com metadados
  function docToInterval(doc) {
    let start, end;
    if (doc.startDateTime && doc.endDateTime) {
      start = new Date(doc.startDateTime);
      end = new Date(doc.endDateTime);
    } else {
      const d = new Date(doc.date);
      const t = String(doc.time || '').trim();
      const [h, m] = t.split(':').map(Number);
      start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h || 0, m || 0, 0, 0);
      const duration = doc.duration || 40;
      end = new Date(start.getTime() + duration * 60000);
    }
    return {
      start,
      end,
      doc,
      source: doc.operationalStatus === 'pre_agendado' ? 'pre_agendado' : (doc.status ? 'session' : 'appointment')
    };
  }

  return {
    intervals: [
      ...doctorAppointments.map(docToInterval),
      ...preAgendamentos.map(docToInterval),
      ...packageSessions.map(docToInterval)
    ],
    lockMap,
    doctorName
  };
}

/**
 * Retorna a ocupação de um slot específico.
 * Autoridade única: usada tanto por slots quanto por conflict check.
 */
function getSlotOccupancy({ time, duration = 40, date, occupancyData, excludeAppointmentId = null }) {
  const timeHHmm = normalizeTimeHHmm(time);
  if (!timeHHmm) return { occupied: false };

  const [sh, sm] = timeHHmm.split(':').map(Number);
  // Usa a data explícita (YYYY-MM-DD) para montar o slot, não depende de haver intervalos
  const slotDate = new Date(`${date}T12:00:00-03:00`);
  const slotStart = new Date(slotDate.getFullYear(), slotDate.getMonth(), slotDate.getDate(), sh, sm, 0, 0);
  const slotEnd = new Date(slotStart.getTime() + (parseInt(duration) || 40) * 60000);

  for (const interval of occupancyData.intervals) {
    // Skip self se for edição
    if (excludeAppointmentId && interval.doc._id?.toString?.() === excludeAppointmentId) {
      continue;
    }

    const sameDay = interval.start.toDateString() === slotStart.toDateString();
    if (!sameDay) continue;

    const overlaps = interval.start < slotEnd && interval.end > slotStart;
    if (overlaps) {
      return {
        occupied: true,
        reason: interval.source,
        source: interval.source,
        metadata: interval.doc
      };
    }
  }

  const activeLock = occupancyData.lockMap.get(timeHHmm);
  if (activeLock) {
    return {
      occupied: true,
      reason: 'shadow_lock',
      source: 'shadow_lock',
      metadata: activeLock
    };
  }

  return { occupied: false };
}

// ======================================================
// 🔧 FALLBACK: Quando doctor não tem agenda → vazio
// ======================================================
function generateDefaultSlots() {
  return [];
}

// ======================================================
// 🔧 FUNÇÃO: Calcular slots disponíveis (reutilizável)
// Retorna: [{ time, available, reason?, label? }]
// ======================================================
export async function calculateAvailableSlots(doctorId, date) {
  console.log(`[calculateAvailableSlots] doctorId=${doctorId}, date=${date}`);
  
  const doctor = await Doctor.findById(doctorId).lean();
  if (!doctor) {
    throw new Error("Médico não encontrado");
  }

  const dayKey = getDayKeyFromYMD(date);
  console.log(`[calculateAvailableSlots] dayKey=${dayKey}, doctorName=${doctor.fullName}`);
  console.log(`[calculateAvailableSlots] weeklyAvailability=`, JSON.stringify(doctor.weeklyAvailability));

  // 🗓️ VERIFICAÇÃO DE FERIADO (prioridade máxima)
  // Verifica feriado por horário (suporta feriados parciais como Quarta-feira de Cinzas)
  const getHolidayInfoForTime = (time) => {
    return isTimeBlockedByHoliday(date, time);
  };

  const dailyAvailability = doctor.weeklyAvailability?.find((d) => d.day === dayKey);
  const rawTimes = dailyAvailability?.times || [];
  
  console.log(`[calculateAvailableSlots] rawTimes=`, rawTimes);

  if (!rawTimes.length) {
    console.log(`[calculateAvailableSlots] Sem horários configurados para ${dayKey}`);
    return generateDefaultSlots();
  }

  // normalize + dedupe + sort + business hours
  const normalizedTimes = Array.from(
    new Set(
      rawTimes
        .map(normalizeTimeHHmm)
        .filter(Boolean)
        .filter(inBusinessHoursHHmm)
    )
  ).sort();

  if (!normalizedTimes.length) {
    console.log(`[calculateAvailableSlots] Sem horários normalizados válidos`);
    return generateDefaultSlots();
  }
  
  console.log(`[calculateAvailableSlots] normalizedTimes=`, normalizedTimes);

  // 🟢 SINGLE SOURCE OF TRUTH: busca ocupação do dia uma única vez
  const occupancyData = await fetchOccupancyData(doctorId, date);

  // 🧠 NOVO: Shadow patterns (recorrência inteligente) — cache + fallback on-the-fly
  const rawShadowPatterns = await ShadowPatternService.findPatternsForDoctorDay(doctorId, date).catch(err => {
    console.error('[calculateAvailableSlots] Erro ao buscar shadow patterns:', err.message);
    return new Map();
  });
  const shadowMap = rawShadowPatterns instanceof Map ? rawShadowPatterns : new Map();

  // 🆕 NOVO: Montar array de slots com metadados
  const slotsWithMetadata = normalizedTimes.map((slotTime) => {
    // Prioridade 1: Feriado (verifica por horário - suporta feriados parciais)
    const holidayCheck = getHolidayInfoForTime(slotTime);
    if (holidayCheck && holidayCheck.blocked) {
      return {
        time: slotTime,
        available: false,
        reason: 'holiday',
        label: holidayCheck.name + (holidayCheck.note ? ` (${holidayCheck.note})` : '')
      };
    }

    // Prioridade 2: Ocupação (appointment / session / pre_agendado / shadow_lock)
    const occupancy = getSlotOccupancy({ time: slotTime, duration: 40, date, occupancyData });

    if (occupancy.occupied) {
      console.log(`[calculateAvailableSlots] Slot ${slotTime} BLOQUEADO por ${occupancy.reason}`);
      if (occupancy.reason === 'shadow_lock') {
        return {
          time: slotTime,
          available: false,
          reason: 'shadow_lock',
          label: `Reservado: ${occupancy.metadata.patientName}`
        };
      }
      return {
        time: slotTime,
        available: false,
        reason: occupancy.reason,
        label: 'Horário Ocupado'
      };
    }

    // Disponível — verificar shadow patterns (recorrência inteligente)
    const shadowPatterns = shadowMap.get(slotTime) || [];
    if (shadowPatterns.length > 0) {
      const topPattern = shadowPatterns.sort((a, b) => b.confidence - a.confidence)[0];
      return {
        time: slotTime,
        available: true,
        signals: {
          isShadow: true,
          isPreferredTime: false
        },
        shadow: {
          patientId: topPattern.patientId,
          patientName: topPattern.patientName,
          occurrences: topPattern.occurrences,
          lastDates: topPattern.lastDates,
          confidence: topPattern.confidence
        }
      };
    }

    return {
      time: slotTime,
      available: true
    };
  });
  
  const totalAppointments = occupancyData.intervals.length;
  console.log(`[calculateAvailableSlots] totalOccupancyIntervals=${totalAppointments}`);
  console.log(`[calculateAvailableSlots] slotsWithMetadata=`, slotsWithMetadata);

  return slotsWithMetadata;
}

// ======================================================
// 🔧 FUNÇÃO REUTILIZÁVEL: Verifica overlap de slot
// Usada em: create, update, reschedule, availability
// ======================================================
/**
 * Verifica se existe conflito de horário para um determinado médico e data.
 * Considera overlap de intervalos (não apenas time exato).
 * 
 * @param {Object} params
 * @param {string} params.doctorId - ID do médico
 * @param {string|Date} params.date - Data (YYYY-MM-DD ou Date)
 * @param {string} params.time - Horário (HH:mm)
 * @param {number} [params.duration=40] - Duração em minutos
 * @param {string} [params.excludeAppointmentId] - ID para ignorar (edição/reschedule)
 * @returns {Promise<Object|null>} - Retorna o primeiro conflito encontrado ou null
 */
export async function checkSlotOverlap({ doctorId, date, time, duration = 40, excludeAppointmentId = null }) {
  if (!doctorId || !date || !time) return null;
  if (!isValidObjectId(doctorId)) return null;

  const timeHHmm = normalizeTimeHHmm(time);
  if (!timeHHmm) return null;

  const newStart = timeToMinutes(timeHHmm);
  const newEnd = newStart + (parseInt(duration) || 40);

  // 🟢 Usa a mesma fonte de verdade de ocupação
  const occupancyData = await fetchOccupancyData(doctorId, date);
  const occupancy = getSlotOccupancy({
    time,
    duration,
    date,
    occupancyData,
    excludeAppointmentId
  });

  if (occupancy.occupied) {
    const metadata = occupancy.metadata || {};
    console.log(`[checkSlotOverlap] CONFLITO: Novo ${timeHHmm}-${newEnd} ocupado por ${occupancy.reason} | _id=${metadata._id}`);
  }

  return occupancy.occupied ? (occupancy.metadata || {}) : null;
}

// ======================================================
// ✅ GET: /available-slots?doctorId=...&date=YYYY-MM-DD
// ======================================================
export const getAvailableTimeSlots = async (req, res) => {
  console.log("[AVAILABLE-SLOTS]", req.query);

  try {
    const { doctorId, date } = req.query;

    if (!doctorId || !date) {
      return res.status(400).json({ error: "doctorId e date são obrigatórios" });
    }

    if (!isValidObjectId(doctorId)) {
      return res.status(400).json({ error: "doctorId inválido" });
    }

    const availableSlots = await calculateAvailableSlots(doctorId, date);
    return res.json(availableSlots);
  } catch (err) {
    console.error("❌ Erro getAvailableTimeSlots:", err);
    return res.status(500).json({ error: err.message });
  }
};
