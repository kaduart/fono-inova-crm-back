import axios from "axios";
import express from "express";
import mongoose from "mongoose";
import { agendaAuth } from "../middleware/agendaAuth.js";
import { getIo } from "../config/socket.js"; // ✅ ADICIONAR IMPORT
import Doctor from "../models/Doctor.js";
import Package from "../models/Package.js";
import PreAgendamento from "../models/PreAgendamento.js";
import { bookFixedSlot, fetchAvailableSlotsForDoctor } from "../services/amandaBookingService.js";
import { findDoctorByName } from "../utils/doctorHelper.js";
const router = express.Router();

const API_BASE = process.env.API_BASE || "http://localhost:5000";
const api = axios.create({ baseURL: API_BASE, timeout: 8000 });


/**
 * POST /api/import-from-agenda
 * Recebe da agenda externa e cria PRE-AGENDAMENTO
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

    // 1) Buscar doutor
    const doctor = await findDoctorByName(professionalName);

    // 2) Verificar se paciente já existe...
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

    // 3) Criar PRÉ-AGENDAMENTO
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

    // ✅ EMITIR SOCKET (novo pré-agendamento)
    try {
      const io = getIo();
      io.emit("preagendamento:new", {
        id: String(preAgendamento._id),
        patientName: preAgendamento.patientInfo.fullName,
        phone: preAgendamento.patientInfo.phone,
        specialty: preAgendamento.specialty,
        preferredDate: preAgendamento.preferredDate,
        preferredTime: preAgendamento.preferredTime,
        status: preAgendamento.status,
        urgency: preAgendamento.urgency,
        createdAt: preAgendamento.createdAt
      });
      console.log(`📡 Socket emitido: preagendamento:new ${preAgendamento._id}`);
    } catch (socketError) {
      console.error('⚠️ Erro ao emitir socket:', socketError.message);
    }

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
 * POST /api/import-from-agenda/confirmar-por-external-id
 * Confirma usando o externalId
 */
router.post("/import-from-agenda/confirmar-por-external-id", agendaAuth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const {
      externalId,
      doctorId,
      date,
      time,
      sessionValue,
      serviceType = 'evaluation',
      paymentMethod = 'pix',
      notes
    } = req.body;

    if (!externalId) {
      return res.status(400).json({ success: false, error: 'externalId é obrigatório' });
    }

    console.log(`[CONFIRMAR-POR-EXTERNAL-ID] Buscando pré-agendamento com externalId: ${externalId}`);

    const pre = await PreAgendamento.findOne({ externalId }).session(session);

    if (!pre) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        error: 'Pré-agendamento não encontrado',
        externalId
      });
    }

    if (pre.status === 'importado') {
      await session.commitTransaction();
      return res.json({
        success: true,
        message: 'Já foi importado',
        appointmentId: pre.importedToAppointment
      });
    }

    // Buscar doutor...
    let doctor = null;

    if (doctorId) {
      doctor = await Doctor.findById(doctorId).session(session);
    }

    if (!doctor && pre.professionalName) {
      const doctorData = await findDoctorByName(pre.professionalName);
      if (doctorData) {
        doctor = await Doctor.findById(doctorData._id).session(session);
      }
    }

    if (!doctor) {
      await session.abortTransaction();
      throw new Error(`Doutor não encontrado. ID: ${doctorId}, Nome: ${pre.professionalName}`);
    }

    console.log(`[CONFIRMAR-POR-EXTERNAL-ID] Importando: ${pre.patientInfo.fullName} com ${doctor.fullName}`);

    // Importar usando bookFixedSlot
    const bookParams = {
      patientInfo: {
        fullName: pre.patientInfo.fullName,
        birthDate: pre.patientInfo.birthDate,
        phone: pre.patientInfo.phone,
        email: pre.patientInfo.email
      },
      doctorId: doctor._id.toString(),
      specialty: pre.specialty,
      date: date || pre.preferredDate,
      time: time || pre.preferredTime,
      sessionType: serviceType === 'evaluation' ? 'avaliacao' : 'sessao',
      serviceType,
      paymentMethod,
      sessionValue: Number(sessionValue || pre.suggestedValue || 0),
      status: 'scheduled',
      notes: `[IMPORTADO DA AGENDA EXTERNA] ${notes || ''}\n${pre.secretaryNotes || ''}`
    };

    const result = await bookFixedSlot(bookParams);

    if (!result.success) {
      await session.abortTransaction();
      throw new Error(result.error || 'Erro ao criar agendamento');
    }

    // Atualizar pré-agendamento
    pre.status = 'importado';
    pre.importedToAppointment = result.appointment._id;
    pre.importedAt = new Date();
    await pre.save({ session });

    await session.commitTransaction();

    console.log(`[CONFIRMAR-POR-EXTERNAL-ID] ✅ Sucesso: ${result.appointment._id}`);

    // ✅ EMITIR SOCKET (importado com sucesso)
    try {
      const io = getIo();
      io.emit("preagendamento:imported", {
        preAgendamentoId: String(pre._id),
        appointmentId: result.appointment._id,
        patientId: result.patientId,
        patientName: pre.patientInfo.fullName,
        timestamp: new Date()
      });
      console.log(`📡 Socket emitido: preagendamento:imported ${pre._id}`);
    } catch (socketError) {
      console.error('⚠️ Erro ao emitir socket:', socketError.message);
    }

    res.json({
      success: true,
      message: 'Importado com sucesso!',
      appointmentId: result.appointment._id,
      patientId: result.patientId,
      preAgendamentoId: pre._id
    });

  } catch (error) {
    await session.abortTransaction();
    console.error('[CONFIRMAR-POR-EXTERNAL-ID] Erro:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  } finally {
    session.endSession();
  }
});

/**
 * POST /api/import-from-agenda/criar-e-confirmar
 * Cria pré-agendamento E já confirma em uma chamada só
 */
router.post("/import-from-agenda/criar-e-confirmar", agendaAuth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

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

    console.log(`[CRIAR-E-CONFIRMAR] Iniciando: ${patientInfo?.fullName} (${firebaseAppointmentId})`);

    // 1) Buscar ou criar paciente...
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

    // 2) Buscar doutor
    const doctor = await findDoctorByName(professionalName);
    if (!doctor) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        code: "DOCTOR_NOT_FOUND",
        error: `Profissional "${professionalName}" não encontrado no CRM`,
      });
    }

    // 3) Criar PRÉ-AGENDAMENTO
    const preAgendamento = await PreAgendamento.create([{
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
      suggestedValue: Number(crm.paymentAmount || 0),
      status: 'novo',
      secretaryNotes: [
        responsible && `Responsável: ${responsible}`,
        observations && `Obs: ${observations}`,
        `[CRIADO E CONFIRMADO VIA AGENDA EXTERNA]`
      ].filter(Boolean).join('\n')
    }], { session });

    const pre = preAgendamento[0];
    console.log(`[CRIAR-E-CONFIRMAR] Pré-agendamento criado: ${pre._id}`);

    // ✅ EMITIR SOCKET (novo pré-agendamento)
    try {
      const io = getIo();
      io.emit("preagendamento:new", {
        id: String(pre._id),
        patientName: pre.patientInfo.fullName,
        phone: pre.patientInfo.phone,
        specialty: pre.specialty,
        preferredDate: pre.preferredDate,
        preferredTime: pre.preferredTime,
        status: pre.status,
        urgency: pre.urgency,
        createdAt: pre.createdAt
      });
      console.log(`📡 Socket emitido: preagendamento:new ${pre._id}`);
    } catch (socketError) {
      console.error('⚠️ Erro ao emitir socket (novo):', socketError.message);
    }

    // 4) JÁ CONFIRMA
    const bookParams = {
      patientInfo: {
        fullName: pre.patientInfo.fullName,
        birthDate: pre.patientInfo.birthDate,
        phone: pre.patientInfo.phone,
        email: pre.patientInfo.email
      },
      doctorId: doctor._id.toString(),
      specialty: pre.specialty,
      date: date || pre.preferredDate,
      time: time || pre.preferredTime,
      sessionType: crm.sessionType === 'avaliacao' ? 'avaliacao' : 'sessao',
      serviceType: crm.serviceType || 'evaluation',
      paymentMethod: crm.paymentMethod || 'pix',
      sessionValue: Number(crm.paymentAmount || 0),
      status: 'scheduled',
      notes: `[CRIADO E CONFIRMADO VIA AGENDA EXTERNA]\n${pre.secretaryNotes || ''}`
    };

    const result = await bookFixedSlot(bookParams);

    if (!result.success) {
      await session.abortTransaction();
      throw new Error(result.error || 'Erro ao criar agendamento');
    }

    // 5) Atualiza pré-agendamento como importado
    pre.status = 'importado';
    pre.importedToAppointment = result.appointment._id;
    pre.importedAt = new Date();
    await pre.save({ session });

    await session.commitTransaction();

    console.log(`[CRIAR-E-CONFIRMAR] ✅ Sucesso: ${result.appointment._id}`);

    // ✅ EMITIR SOCKET (importado)
    setTimeout(() => {
      try {
        const io = getIo();
        io.emit("preagendamento:imported", {
          preAgendamentoId: String(pre._id),
          appointmentId: result.appointment._id,
          patientId: result.patientId,
          patientName: pre.patientInfo.fullName,
          timestamp: new Date()
        });
        console.log(`📡 Socket emitido: preagendamento:imported ${pre._id}`);
      } catch (socketError) {
        console.error('⚠️ Erro ao emitir socket:', socketError.message);
      }
    }, 3500);

    return res.status(201).json({
      success: true,
      message: 'Pré-agendamento criado e confirmado!',
      preAgendamentoId: pre._id,
      appointmentId: result.appointment._id,
      patientId: result.patientId,
      externalId: firebaseAppointmentId
    });

  } catch (err) {
    await session.abortTransaction();
    console.error("[CRIAR-E-CONFIRMAR] error:", err);
    return res.status(500).json({
      success: false,
      code: "INTERNAL_ERROR",
      error: err.message
    });
  } finally {
    session.endSession();
  }
});

export default router;