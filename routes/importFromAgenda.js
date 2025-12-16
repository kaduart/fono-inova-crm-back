import axios from "axios";
import express from "express";
import { agendaAuth } from "../middleware/agendaAuth.js";
import Package from "../models/Package.js";
import { bookFixedSlot, fetchAvailableSlotsForDoctor } from "../services/amandaBookingService.js";
import { findDoctorByName } from "../utils/doctorHelper.js";
const router = express.Router();

const API_BASE = process.env.API_BASE || "http://localhost:5000";
const api = axios.create({ baseURL: API_BASE, timeout: 8000 });


router.post("/import-from-agenda", agendaAuth, async (req, res) => {
  try {
    const {
      firebaseAppointmentId,
      professionalName,
      date,
      time,
      specialty,
      patientInfo,
      responsible,
      observations,
      crm: crmRaw, // 👈 vem do front como req.body.crm
    } = req.body;

    const crm = crmRaw || {};

    const cleanPhone = (patientInfo?.phone || "").replace(/\D/g, "");

    const serviceTypeRaw = crm.serviceType || req.body.serviceType || "individual_session";

    // considera pacote se vier explicitamente como package_session OU se usePackage vier true
    const isPackage =
      serviceTypeRaw === "package_session" ||
      crm.usePackage === true ||
      req.body.usePackage === true;

    const resolvedServiceType = isPackage ? "package_session" : "individual_session";


    const resolvedSessionType = crm.sessionType || req.body.sessionType || "evaluation";
    const resolvedPaymentMethod = crm.paymentMethod || req.body.paymentMethod || "pix";
    const resolvedPaymentAmount = Number(crm.paymentAmount ?? req.body.sessionValue ?? 0);

    // 1) doctor
    const doctor = await findDoctorByName(professionalName);
    if (!doctor) {
      return res.status(404).json({
        success: false,
        code: "DOCTOR_NOT_FOUND",
        error: `Profissional não encontrado no CRM: "${professionalName}"`,
      });
    }

    // 2) valida slot
    const slots = await fetchAvailableSlotsForDoctor({ doctorId: doctor._id, date });
    if (!slots?.includes(time)) {
      return res.status(409).json({
        success: false,
        code: "TIME_CONFLICT",
        error: `Horário ${time} não disponível para ${professionalName} em ${date}`,
        alternatives: (slots || []).slice(0, 6),
      });
    }

    // 3) resolve patientId
    let patientId = null;

    const authHeader =
      req.headers.authorization || `Bearer ${process.env.AGENDA_EXPORT_TOKEN}`;


    try {
      const patientResponse = await api.post(
        "/api/patients/add",
        {
          fullName: patientInfo?.fullName,
          dateOfBirth: patientInfo?.birthDate,
          phone: cleanPhone,
          email: patientInfo?.email || undefined,
        },
        {
          headers: { Authorization: authHeader },
        }
      );

      if (patientResponse.data?.success && patientResponse.data?.data?._id) {
        patientId = patientResponse.data.data._id;
      }
    } catch (patientError) {
      if (patientError.response?.status === 409 && patientError.response.data?.existingId) {
        patientId = patientError.response.data.existingId;
      } else {
        throw patientError;
      }
    }

    if (!patientId) {
      return res.status(400).json({
        success: false,
        code: "PATIENT_ERROR",
        error: "Não foi possível criar/encontrar o paciente",
      });
    }

    // 4) pacote (se for pacote)

    let packageId = null;

    if (isPackage) {
      packageId = await findActivePackageForPatient({
        patientId,
        specialty: (specialty || doctor.specialty),
        doctorId: doctor._id,
      });

      if (!packageId) {
        return res.status(404).json({
          success: false,
          code: "PACKAGE_NOT_FOUND",
          error: "Paciente não possui pacote ativo com sessões disponíveis para essa especialidade.",
        });
      }
    }

    // 5) notes
    const notes =
      `[IMPORT AGENDA PROVISÓRIA] firebase=${firebaseAppointmentId || "-"}\n` +
      (responsible ? `Responsável: ${responsible}\n` : "") +
      (observations ? `Obs: ${observations}` : "");

    // 6) book no CRM
    const result = await bookFixedSlot({
      patientInfo: {
        fullName: patientInfo?.fullName,
        birthDate: patientInfo?.birthDate,
        phone: cleanPhone,
        email: patientInfo?.email,
      },
      doctorId: doctor._id,
      specialty: req.body.specialtyKey || req.body.specialty || doctor.specialty,
      date,
      time,
      notes,
      sessionType: resolvedSessionType,
      serviceType: resolvedServiceType,
      paymentMethod: resolvedPaymentMethod,
      paymentAmount: resolvedPaymentAmount,
      sessionValue: resolvedPaymentAmount,
      status: "scheduled",

      // ✅ amarra pacote quando for pacote (se teu bookFixedSlot suportar)
      ...(isPackage ? { packageId, usePackage: true } : {}),
    });

    if (!result.success) {
      return res.status(result.code === "TIME_CONFLICT" ? 409 : 400).json(result);
    }

    return res.json({
      success: true,
      patientId: result.patientId,
      appointmentId: result.appointment?._id,
      paymentId: result.payment?._id,
      sessionId: result.session?._id,
      packageId: result.package?._id || packageId || null
    });
  } catch (err) {
    console.error("[IMPORT_FROM_AGENDA] error:", err);
    return res.status(500).json({ success: false, code: "INTERNAL_ERROR", error: err.message });
  }
});

async function findActivePackageForPatient({ patientId, specialty, doctorId }) {
  const base = {
    patient: patientId,
    specialty,
    status: { $in: ["active", "in-progress"] },
    $expr: { $lt: ["$sessionsDone", "$totalSessions"] },
  };

  // tenta priorizar o doctor
  const preferred = await Package.findOne({ ...base, doctor: doctorId })
    .sort({ date: -1 })
    .select("_id")
    .lean();

  if (preferred?._id) return preferred._id.toString();

  const any = await Package.findOne(base).sort({ date: -1 }).select("_id").lean();
  return any?._id ? any._id.toString() : null;
}


export default router;
