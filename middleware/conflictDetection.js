import mongoose from "mongoose";
import { NON_BLOCKING_OPERATIONAL_STATUSES } from "../constants/appointmentStatus.js";
import Appointment from "../models/Appointment.js";
import Doctor from "../models/Doctor.js";
import Session from "../models/Session.js";
import { isNationalHoliday, getHolidayName, isTimeBlockedByHoliday } from "../config/feriadosBR-dynamic.js";
import { buildDayRange, buildDateTime } from "../utils/datetime.js";

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
export const checkAppointmentConflicts = async (req, res, next) => {
  const { doctorId, patientId, date, time, operationalStatus, isNewPatient } = req.body;
  const appointmentId = req.params?.id;

  // 🔥 Pré-agendamentos podem não ter patientId (paciente ainda não cadastrado)
  const isPreAgendamento = operationalStatus === 'pre_agendado' || isNewPatient === true;

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

  const timeHHmm = normalizeTimeHHmm(time);
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

    // 🆕 NOVO: Buscar TODOS os agendamentos do dia para verificar sobreposição
    const queries = [
      // Doctor appointments (sempre)
      Appointment.find({
        doctor: doctorObjectId,
        date: dayRange,
        operationalStatus: { $nin: NON_BLOCKING_OPERATIONAL_STATUSES },
        ...excludeSelf,
      })
        .select("time duration patient")
        .populate("patient", "fullName")
        .lean(),

      // Patient appointments (só se tem patientId)
      patientObjectId
        ? Appointment.find({
            patient: patientObjectId,
            date: dayRange,
            operationalStatus: { $nin: NON_BLOCKING_OPERATIONAL_STATUSES },
            ...excludeSelf,
          })
            .select("time duration doctor")
            .populate("doctor", "fullName")
            .lean()
        : Promise.resolve([]),

      // Doctor sessions (sempre)
      Session.find({
        doctor: doctorObjectId,
        date: dayRange,
        status: { $nin: ['canceled'] },
      })
        .select("time patient")
        .populate("patient", "fullName")
        .lean(),

      // Patient sessions (só se tem patientId)
      patientObjectId
        ? Session.find({
            patient: patientObjectId,
            date: dayRange,
            status: { $nin: ['canceled'] },
          })
            .select("time doctor")
            .populate("doctor", "fullName")
            .lean()
        : Promise.resolve([]),
    ];

    const [doctorAppointments, patientAppointments, doctorSessions, patientSessions] = await Promise.all(queries);

    // Combina appointments + sessions para checagem unificada (sessions usam duration 40 padrão)
    const allDoctorSlots = [...doctorAppointments, ...doctorSessions];
    const allPatientSlots = [...patientAppointments, ...patientSessions];

    // 🆕 NOVO: Verificar sobreposição de intervalos para o médico
    const doctorConflict = allDoctorSlots.find((appt) => {
      const apptTime = normalizeTimeHHmm(appt.time);
      if (!apptTime) return false;
      
      const apptDuration = appt.duration || 40;
      const apptStart = timeToMinutes(apptTime);
      const apptEnd = apptStart + apptDuration;
      
      // Verifica sobreposição: [newStart, newEnd) intersect [apptStart, apptEnd)
      const overlaps = newStartMinutes < apptEnd && newEndMinutes > apptStart;
      
      if (overlaps) {
        console.log(`[checkAppointmentConflicts] CONFLITO MÉDICO: Novo ${timeHHmm}-${newEndMinutes} sobrepõe existente ${apptTime}-${apptEnd}`);
      }
      
      return overlaps;
    });

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

    if (doctorConflict) {
      return res.status(409).json({
        error: "Conflito de agenda médica",
        message: "O médico já possui um compromisso neste horário",
        conflict: {
          appointmentId: doctorConflict._id,
          patientName: doctorConflict.patient?.fullName || "Nome não disponível",
          existingAppointment: doctorConflict,
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

  // 🚨 FIX: Usar helper padronizado para range de busca (timezone-safe)
  const dayRange = buildDayRange(date);
  
  console.log(`[calculateAvailableSlots] Buscando agendamentos entre ${dayRange.$gte.toISOString()} e ${dayRange.$lte.toISOString()}`);

  // 🚨 FIX: Buscar agendamentos COM startDateTime/endDateTime (novo padrão Date-based)
  const [bookedAppointments, preAgendadosAtivos, packageSessions] = await Promise.all([
    Appointment.find({
      doctor: toObjectId(doctorId),
      date: dayRange,
      operationalStatus: { $nin: NON_BLOCKING_OPERATIONAL_STATUSES },
    })
      .select("date time duration startDateTime endDateTime patient -_id")
      .lean(),

    // 🚨 FIX: pre_agendado agora BLOQUEIA o slot
    Appointment.find({
      date: dayRange,
      operationalStatus: 'pre_agendado',
      $or: [
        { doctor: toObjectId(doctorId) },
        { professionalName: { $regex: new RegExp(doctor.fullName, 'i') } }
      ]
    })
      .select("date time duration startDateTime endDateTime patient -_id")
      .lean(),

    // 🚨 FIX: Sessões de pacote (modelo Session) bloqueiam slots
    Session.find({
      doctor: toObjectId(doctorId),
      date: dayRange,
      status: { $nin: ['canceled'] },
    })
      .select("date time duration -_id")
      .lean(),
  ]);

  // 🕐 Helper: converte documento (Appointment/Session) para intervalo Date
  function docToInterval(doc) {
    if (doc.startDateTime && doc.endDateTime) {
      return { start: new Date(doc.startDateTime), end: new Date(doc.endDateTime) };
    }
    // Fallback legado: monta de date + time + duration
    const d = new Date(doc.date);
    const t = String(doc.time || '').trim();
    const [h, m] = t.split(':').map(Number);
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h || 0, m || 0, 0, 0);
    const duration = doc.duration || 40;
    const end = new Date(start.getTime() + duration * 60000);
    return { start, end };
  }

  // Combinar todos os agendamentos/sessions como intervalos Date
  const allIntervals = [
    ...bookedAppointments,
    ...preAgendadosAtivos,
    ...packageSessions
  ].map(docToInterval);

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

    // Prioridade 2: Date-based overlap
    const slotDate = new Date(`${date}T12:00:00-03:00`);
    const [sh, sm] = slotTime.split(':').map(Number);
    const slotStart = new Date(slotDate.getFullYear(), slotDate.getMonth(), slotDate.getDate(), sh, sm, 0, 0);
    const slotEnd = new Date(slotStart.getTime() + 40 * 60000);

    const isBlocked = allIntervals.some(ai => {
      const sameDay = ai.start.toDateString() === slotStart.toDateString();
      if (!sameDay) return false;
      return ai.start < slotEnd && ai.end > slotStart;
    });

    if (isBlocked) {
      console.log(`[calculateAvailableSlots] Slot ${slotTime} BLOQUEADO por agendamento`);
      return {
        time: slotTime,
        available: false,
        reason: 'appointment',
        label: 'Horário Ocupado'
      };
    }

    // Disponível
    return {
      time: slotTime,
      available: true
    };
  });
  
  console.log(`[calculateAvailableSlots] bookedAppointments=${bookedAppointments.length}, preAgendados=${preAgendadosAtivos.length}, packageSessions=${packageSessions.length}, total=${allAppointments.length}`);
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

  const dayRange = buildDayRange(date);
  const doctorObjectId = toObjectId(doctorId);
  const excludeFilter = excludeAppointmentId && isValidObjectId(excludeAppointmentId)
    ? { _id: { $ne: toObjectId(excludeAppointmentId) } }
    : {};

  // Busca appointments + sessions do médico no dia
  const [doctorAppointments, doctorSessions] = await Promise.all([
    Appointment.find({
      doctor: doctorObjectId,
      date: dayRange,
      operationalStatus: { $nin: NON_BLOCKING_OPERATIONAL_STATUSES },
      ...excludeFilter,
    })
      .select("time duration")
      .lean(),
    Session.find({
      doctor: doctorObjectId,
      date: dayRange,
      status: { $nin: ['canceled'] },
      ...excludeFilter,
    })
      .select("time duration")
      .lean(),
  ]);

  const allSlots = [...doctorAppointments, ...doctorSessions];

  const conflict = allSlots.find((slot) => {
    const slotTime = normalizeTimeHHmm(slot.time);
    if (!slotTime) return false;

    const slotDuration = slot.duration || 40;
    const slotStart = timeToMinutes(slotTime);
    const slotEnd = slotStart + slotDuration;

    const overlaps = newStart < slotEnd && newEnd > slotStart;

    if (overlaps) {
      console.log(`[checkSlotOverlap] CONFLITO: Novo ${timeHHmm}-${newEnd} sobrepõe existente ${slotTime}-${slotEnd}`);
    }

    return overlaps;
  });

  return conflict || null;
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
