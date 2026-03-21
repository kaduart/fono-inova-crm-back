import mongoose from "mongoose";
import { NON_BLOCKING_OPERATIONAL_STATUSES } from "../constants/appointmentStatus.js";
import Appointment from "../models/Appointment.js";
import Doctor from "../models/Doctor.js";

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
  const { doctorId, patientId, date, time } = req.body;
  const appointmentId = req.params?.id;

  if (!doctorId || !patientId || !date || !time) {
    return res.status(400).json({
      error: "Dados incompletos para verificação de conflitos",
      requiredFields: {
        doctorId: !doctorId ? "Campo obrigatório" : "OK",
        patientId: !patientId ? "Campo obrigatório" : "OK",
        date: !date ? "Campo obrigatório" : "OK",
        time: !time ? "Campo obrigatório" : "OK",
      },
    });
  }

  if (!isValidObjectId(doctorId) || !isValidObjectId(patientId)) {
    return res.status(400).json({
      error: "IDs inválidos",
      details: {
        doctorId: isValidObjectId(doctorId) ? "OK" : "ObjectId inválido",
        patientId: isValidObjectId(patientId) ? "OK" : "ObjectId inválido",
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
    const patientObjectId = toObjectId(patientId);
    const excludeSelf = appointmentId ? { _id: { $ne: toObjectId(appointmentId) } } : {};
    
    // 🆕 NOVO: Duração do novo agendamento (padrão 40 min)
    const newDuration = parseInt(req.body.duration) || 40;
    const newStartMinutes = timeToMinutes(timeHHmm);
    const newEndMinutes = newStartMinutes + newDuration;

    // 🆕 NOVO: Buscar TODOS os agendamentos do dia para verificar sobreposição
    const [doctorAppointments, patientAppointments] = await Promise.all([
      Appointment.find({
        doctor: doctorObjectId,
        date,
        operationalStatus: { $nin: NON_BLOCKING_OPERATIONAL_STATUSES },
        ...excludeSelf,
      })
        .select("time duration patient")
        .populate("patient", "fullName")
        .lean(),

      Appointment.find({
        patient: patientObjectId,
        date,
        operationalStatus: { $nin: NON_BLOCKING_OPERATIONAL_STATUSES },
        ...excludeSelf,
      })
        .select("time duration doctor")
        .populate("doctor", "fullName")
        .lean(),
    ]);

    // 🆕 NOVO: Verificar sobreposição de intervalos para o médico
    const doctorConflict = doctorAppointments.find((appt) => {
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
    const patientConflict = patientAppointments.find((appt) => {
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
// 🔧 FUNÇÃO: Calcular slots disponíveis (reutilizável)
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

  const dailyAvailability = doctor.weeklyAvailability?.find((d) => d.day === dayKey);
  const rawTimes = dailyAvailability?.times || [];
  
  console.log(`[calculateAvailableSlots] rawTimes=`, rawTimes);

  if (!rawTimes.length) {
    console.log(`[calculateAvailableSlots] Sem horários configurados para ${dayKey}`);
    return [];
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
    return [];
  }
  
  console.log(`[calculateAvailableSlots] normalizedTimes=`, normalizedTimes);

  // 🚨 FIX: Buscar agendamentos COM DURAÇÃO para verificar sobreposição
  const bookedAppointments = await Appointment.find({
    doctor: toObjectId(doctorId),
    date,
    operationalStatus: { $nin: NON_BLOCKING_OPERATIONAL_STATUSES },
  })
    .select("time duration -_id")
    .lean();

  // 🚨 FIX: pre_agendado agora BLOQUEIA o slot (removido de NON_BLOCKING_OPERATIONAL_STATUSES)
  const preAgendadosAtivos = await Appointment.find({
    date,
    operationalStatus: 'pre_agendado',
    $or: [
      { doctor: toObjectId(doctorId) },
      { professionalName: { $regex: new RegExp(doctor.fullName, 'i') } }
    ]
  })
    .select("time duration -_id")
    .lean();

  // Combinar todos os agendamentos
  const allAppointments = [...bookedAppointments, ...preAgendadosAtivos];

  // 🆕 NOVO: Verificar disponibilidade por intervalo, não por hora exata
  const availableSlots = normalizedTimes.filter((slotTime) => {
    // Verifica se algum agendamento ocupa este slot
    const isBlocked = allAppointments.some((appt) => {
      const apptTime = normalizeTimeHHmm(appt.time);
      if (!apptTime) return false;
      
      // Usa duração do agendamento ou padrão de 40 min
      const apptDuration = appt.duration || 40;
      
      const blocks = appointmentBlocksSlot(slotTime, apptTime, apptDuration);
      
      if (blocks) {
        console.log(`[calculateAvailableSlots] Slot ${slotTime} BLOQUEADO por agendamento às ${apptTime} (duração: ${apptDuration}min)`);
      }
      
      return blocks;
    });
    
    return !isBlocked;
  });
  
  console.log(`[calculateAvailableSlots] totalAppointments=${allAppointments.length}`);
  console.log(`[calculateAvailableSlots] availableSlots=`, availableSlots);

  return availableSlots;
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
