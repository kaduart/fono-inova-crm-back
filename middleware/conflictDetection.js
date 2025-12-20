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

    const [doctorConflict, patientConflict] = await Promise.all([
      Appointment.findOne({
        doctor: doctorObjectId,
        date,
        time: timeHHmm,
        operationalStatus: { $nin: NON_BLOCKING_OPERATIONAL_STATUSES },
        ...excludeSelf,
      })
        .populate("patient", "fullName")
        .lean(),

      Appointment.findOne({
        patient: patientObjectId,
        date,
        time: timeHHmm,
        operationalStatus: { $nin: NON_BLOCKING_OPERATIONAL_STATUSES },
        ...excludeSelf,
      })
        .populate("doctor", "fullName")
        .lean(),
    ]);

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

    const doctor = await Doctor.findById(doctorId).lean();
    if (!doctor) {
      return res.status(404).json({ error: "Médico não encontrado" });
    }

    const dayKey = getDayKeyFromYMD(date);

    const dailyAvailability = doctor.weeklyAvailability?.find((d) => d.day === dayKey);
    const rawTimes = dailyAvailability?.times || [];

    if (!rawTimes.length) return res.json([]);

    // normalize + dedupe + sort + business hours
    const normalizedTimes = Array.from(
      new Set(
        rawTimes
          .map(normalizeTimeHHmm)
          .filter(Boolean)
          .filter(inBusinessHoursHHmm)
      )
    ).sort();

    if (!normalizedTimes.length) return res.json([]);

    const booked = await Appointment.find({
      doctor: toObjectId(doctorId),
      date,
      operationalStatus: { $nin: NON_BLOCKING_OPERATIONAL_STATUSES },
    })
      .select("time -_id")
      .lean();

    const bookedTimes = new Set(
      booked
        .map((a) => normalizeTimeHHmm(a.time))
        .filter(Boolean)
    );

    const availableSlots = normalizedTimes.filter((t) => !bookedTimes.has(t));

    return res.json(availableSlots);
  } catch (err) {
    console.error("❌ Erro getAvailableTimeSlots:", err);
    return res.status(500).json({ error: err.message });
  }
};
