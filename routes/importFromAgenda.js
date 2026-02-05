import axios from "axios";
import express from "express";
import { agendaAuth } from "../middleware/agendaAuth.js";
import Package from "../models/Package.js";
import PreAgendamento from "../models/PreAgendamento.js";
import { bookFixedSlot, fetchAvailableSlotsForDoctor } from "../services/amandaBookingService.js";
import { findDoctorByName } from "../utils/doctorHelper.js";
const router = express.Router();

const API_BASE = process.env.API_BASE || "http://localhost:5000";
const api = axios.create({ baseURL: API_BASE, timeout: 8000 });


/**
 * POST /api/import-from-agenda
 * Recebe da agenda externa e cria PRE-AGENDAMENTO (não Appointment ainda)
 * A secretária confirma depois via painel de Pré-Agendamentos
 */
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
      crm: crmRaw,
    } = req.body;

    const crm = crmRaw || {};
    const cleanPhone = (patientInfo?.phone || "").replace(/\D/g, "");

    // 1) Buscar doutor (apenas para validação e preenchimento)
    const doctor = await findDoctorByName(professionalName);
    
    // 2) Verificar se paciente já existe
    let patientId = null;
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
          headers: { Authorization: req.headers.authorization || `Bearer ${process.env.AGENDA_EXPORT_TOKEN}` },
        }
      );

      if (patientResponse.data?.success && patientResponse.data?.data?._id) {
        patientId = patientResponse.data.data._id;
      }
    } catch (patientError) {
      if (patientError.response?.status === 409 && patientError.response.data?.existingId) {
        patientId = patientError.response.data.existingId;
      }
    }

    // 3) Criar PRE-AGENDAMENTO (não cria Appointment ainda!)
    const preAgendamento = await PreAgendamento.create({
      source: 'agenda_externa',
      externalId: firebaseAppointmentId,
      patientInfo: {
        fullName: patientInfo?.fullName,
        phone: cleanPhone,
        email: patientInfo?.email,
        birthDate: patientInfo?.birthDate
      },
      patientId,
      specialty: (specialty || doctor?.specialty || 'fonoaudiologia').toLowerCase(),
      preferredDate: date,
      preferredTime: time,
      professionalName,
      professionalId: doctor?._id,
      serviceType: crm.serviceType || 'evaluation',
      suggestedValue: Number(crm.paymentAmount || req.body.sessionValue || 0),
      status: 'novo',
      secretaryNotes: [
        responsible && `Responsável: ${responsible}`,
        observations && `Obs: ${observations}`,
        `[IMPORTADO DA AGENDA EXTERNA]`
      ].filter(Boolean).join('\n')
    });

    return res.status(201).json({
      success: true,
      message: 'Pré-agendamento criado com sucesso!',
      preAgendamentoId: preAgendamento._id,
      status: preAgendamento.status,
      urgency: preAgendamento.urgency,
      patientId,
      nextStep: 'Aguardando confirmação da secretária no painel de Pré-Agendamentos'
    });

  } catch (err) {
    console.error("[IMPORT_FROM_AGENDA] error:", err);
    return res.status(500).json({ success: false, code: "INTERNAL_ERROR", error: err.message });
  }
});

/**
 * POST /api/import-from-agenda/:id/confirmar
 * (Opcional) Endpoint para confirmar direto se necessário
 */
router.post("/import-from-agenda/:id/confirmar", agendaAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { doctorId, date, time, sessionValue } = req.body;

    const pre = await PreAgendamento.findById(id);
    if (!pre) {
      return res.status(404).json({ success: false, error: 'Pré-agendamento não encontrado' });
    }

    // Importar usando bookFixedSlot
    const result = await bookFixedSlot({
      patientInfo: {
        fullName: pre.patientInfo.fullName,
        birthDate: pre.patientInfo.birthDate,
        phone: pre.patientInfo.phone,
        email: pre.patientInfo.email
      },
      doctorId: doctorId || pre.professionalId,
      specialty: pre.specialty,
      date: date || pre.preferredDate,
      time: time || pre.preferredTime,
      sessionValue: sessionValue || pre.suggestedValue,
      status: 'scheduled',
      notes: `[IMPORTADO DO PRE-AGENDAMENTO ${pre._id}]`
    });

    if (!result.success) {
      return res.status(400).json(result);
    }

    // Atualizar pré-agendamento
    pre.status = 'importado';
    pre.importedToAppointment = result.appointment._id;
    pre.importedAt = new Date();
    await pre.save();

    return res.json({
      success: true,
      appointmentId: result.appointment._id,
      message: 'Agendamento confirmado e importado!'
    });

  } catch (err) {
    console.error("[IMPORT_CONFIRM] error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});


export default router;
