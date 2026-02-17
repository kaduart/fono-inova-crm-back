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

import Appointment from "../models/Appointment.js";
import Session from "../models/Session.js";
import Payment from "../models/Payment.js";
import Patient from "../models/Patient.js";

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
      externalId,
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
      externalId,
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
      serviceType: (crm.serviceType === 'individual_session' ? 'session' : (crm.serviceType || 'evaluation')),
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

      console.log(`[CONFIRMAR-POR-EXTERNAL-ID] ⚠️ PreAgendamento ${pre._id} já foi importado para ${pre.importedToAppointment}`);

      return res.json({
        success: true,
        message: 'Já foi importado anteriormente',
        appointmentId: pre.importedToAppointment,
        preAgendamentoId: pre._id,
        importedAt: pre.importedAt,
        warning: 'Este pré-agendamento já havia sido convertido em agendamento'
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

    // Criar appointment como PRÉ-AGENDADO
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
      status: 'pre-scheduled', // 🆕 Criar como pré-agendado
      notes: `[IMPORTADO DA AGENDA EXTERNA - AGUARDANDO CONFIRMAÇÃO] ${notes || ''}\n${pre.secretaryNotes || ''}`
    };

    const result = await bookFixedSlot(bookParams);

    if (!result.success) {
      await session.abortTransaction();
      throw new Error(result.error || 'Erro ao criar agendamento');
    }
    const io = getIo();
    io.emit("appointmentCreated", result.appointment);

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
      externalId,
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

    console.log(`[CRIAR-E-CONFIRMAR] Iniciando: ${patientInfo?.fullName} (${externalId})`);

    // 🔍 Verificar se já existe PreAgendamento com este externalId
    const existingPre = await PreAgendamento.findOne({ externalId }).session(session);

    if (existingPre) {
      console.log(`[CRIAR-E-CONFIRMAR] ⚠️ PreAgendamento ${existingPre._id} já existe para externalId: ${externalId}`);

      // Se já foi importado E já tem appointment
      if (existingPre.status === 'importado' && existingPre.importedToAppointment) {
        // Buscar appointment existente
        const existingAppointment = await Appointment.findById(existingPre.importedToAppointment).session(session);

        if (existingAppointment) {
          // Se já está scheduled, retorna sucesso
          if (existingAppointment.operationalStatus === 'scheduled') {
            await session.commitTransaction();
            return res.json({
              success: true,
              message: 'Agendamento já confirmado anteriormente',
              appointmentId: existingAppointment._id,
              preAgendamentoId: existingPre._id,
              status: 'already_confirmed'
            });
          }

          // Se está pre-scheduled, vamos confirmar agora
          if (existingAppointment.operationalStatus === 'pre-scheduled') {
            console.log(`[CRIAR-E-CONFIRMAR] Confirmando appointment pré-agendado: ${existingAppointment._id}`);

            existingAppointment.operationalStatus = 'scheduled';
            existingAppointment.status = 'scheduled';
            existingAppointment.updatedAt = new Date();

            if (!existingAppointment.history) existingAppointment.history = [];
            existingAppointment.history.push({
              action: 'confirmacao_via_agenda_externa',
              changedBy: null,
              timestamp: new Date(),
              context: 'operacional',
              details: { from: 'pre-scheduled', to: 'scheduled' }
            });

            await existingAppointment.save({ session });

            // Atualizar session se existir
            if (existingAppointment.session) {
              await Session.findByIdAndUpdate(
                existingAppointment.session,
                {
                  $set: {
                    status: 'scheduled',
                    updatedAt: new Date()
                  }
                },
                { session }
              );
            }

            await session.commitTransaction();

            const io = getIo();
            io.emit("appointmentUpdated", existingAppointment);

            return res.json({
              success: true,
              message: 'Pré-agendamento confirmado com sucesso!',
              appointmentId: existingAppointment._id,
              preAgendamentoId: existingPre._id,
              status: 'confirmed'
            });
          }
        }
      }
    }

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

    // 3) Criar ou reusar PRÉ-AGENDAMENTO
    let pre;

    if (existingPre) {
      // Reusar existente
      pre = existingPre;
      console.log(`[CRIAR-E-CONFIRMAR] Reusando PreAgendamento existente: ${pre._id}`);
    } else {
      // Criar novo
      const preAgendamento = await PreAgendamento.create([{
        source: 'agenda_externa',
        externalId,
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
        serviceType: (crm.serviceType === 'individual_session' ? 'session' : (crm.serviceType || 'evaluation')),
        suggestedValue: Number(crm.paymentAmount || 0),
        status: 'novo',
        secretaryNotes: [
          responsible && `Responsável: ${responsible}`,
          observations && `Obs: ${observations}`,
          `[CRIADO E CONFIRMADO VIA AGENDA EXTERNA]`
        ].filter(Boolean).join('\n')
      }], { session });

      pre = preAgendamento[0];
      console.log(`[CRIAR-E-CONFIRMAR] Pré-agendamento criado: ${pre._id}`);
    }

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

    // 4) CRIAR APPOINTMENT COMO PRÉ-AGENDADO (não confirmado ainda)
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
      status: 'pre-scheduled', // 🆕 Criar como pré-agendado
      notes: `[IMPORTADO DA AGENDA EXTERNA - AGUARDANDO CONFIRMAÇÃO]\n${pre.secretaryNotes || ''}`
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

    return res.status(201).json({
      success: true,
      message: 'Pré-agendamento criado e confirmado!',
      preAgendamentoId: pre._id,
      appointmentId: result.appointment._id,
      patientId: result.patientId,
      externalId
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

/**
 * POST /api/import-from-agenda/sync-cancel
 * Cancela um agendamento vindo da agenda externa
 */
router.post("/import-from-agenda/sync-cancel", agendaAuth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { externalId, reason = "Cancelado via agenda externa", confirmedAbsence = false } = req.body;

    if (!externalId) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, error: "externalId é obrigatório" });
    }

    console.log(`[SYNC-CANCEL] Cancelando agendamento externo: ${externalId}`);

    // 1) Buscar o pré-agendamento pelo externalId
    const preAgendamento = await PreAgendamento.findOne({ externalId }).session(session);

    if (!preAgendamento) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        error: "Pré-agendamento não encontrado",
        externalId
      });
    }

    // 2) Se já foi importado para um agendamento real, cancela o agendamento
    if (preAgendamento.importedToAppointment) {
      const appointment = await Appointment.findById(preAgendamento.importedToAppointment)
        .populate("session payment")
        .session(session);

      if (appointment) {
        // Atualizar Payment (se não for de pacote)
        if (appointment.payment && appointment.payment.kind !== "package_receipt") {
          await Payment.findByIdAndUpdate(
            appointment.payment,
            {
              $set: {
                status: "canceled",
                canceledAt: new Date(),
                canceledReason: reason,
                updatedAt: new Date()
              }
            },
            { session }
          );
        }

        // Atualizar Session - guardando dados financeiros para reaproveitamento
        if (appointment.session) {
          const sessionDoc = await Session.findById(appointment.session).session(session);

          if (sessionDoc) {
            const wasPaid = sessionDoc.paymentStatus === "paid" ||
              sessionDoc.isPaid === true ||
              (sessionDoc.partialAmount && sessionDoc.partialAmount > 0);

            if (wasPaid) {
              sessionDoc.originalPartialAmount = sessionDoc.partialAmount;
              sessionDoc.originalPaymentStatus = sessionDoc.paymentStatus;
              sessionDoc.originalPaymentMethod = sessionDoc.paymentMethod;
              sessionDoc.originalIsPaid = sessionDoc.isPaid;
            }

            sessionDoc.status = "canceled";
            sessionDoc.paymentStatus = "canceled";
            sessionDoc.visualFlag = "blocked";
            sessionDoc.confirmedAbsence = confirmedAbsence;
            sessionDoc.canceledAt = new Date();

            if (!sessionDoc.history) sessionDoc.history = [];
            sessionDoc.history.push({
              action: "cancelamento_via_agenda_externa",
              changedBy: null,
              timestamp: new Date(),
              details: { reason, confirmedAbsence, hadPayment: wasPaid }
            });

            await sessionDoc.save({ session, validateBeforeSave: false });
          }
        }

        // Atualizar Appointment
        await Appointment.findByIdAndUpdate(
          appointment._id,
          {
            $set: {
              operationalStatus: "canceled",
              clinicalStatus: confirmedAbsence ? "missed" : "pending",
              paymentStatus: "canceled",
              visualFlag: "blocked",
              canceledReason: reason,
              canceledAt: new Date(),
              confirmedAbsence,
              updatedAt: new Date()
            },
            $push: {
              history: {
                action: "cancelamento_externo",
                newStatus: "canceled",
                changedBy: null,
                timestamp: new Date(),
                context: "operacional",
                details: { reason, confirmedAbsence, externalId }
              }
            }
          },
          { session }
        );

        console.log(`[SYNC-CANCEL] ✅ Agendamento ${appointment._id} cancelado`);
      }
    }
    const io = getIo();
    io.emit("appointmentUpdated", {
      _id: appointment._id,
      operationalStatus: "canceled"
    });


    // 3) Atualizar o pré-agendamento como cancelado
    preAgendamento.status = "cancelado";
    preAgendamento.canceledAt = new Date();
    preAgendamento.canceledReason = reason;
    preAgendamento.secretaryNotes += `\n[CANCELADO VIA AGENDA EXTERNA - ${new Date().toLocaleString("pt-BR")}]`;
    await preAgendamento.save({ session });

    await session.commitTransaction();

    // 4) Emitir socket para atualizar o painel em tempo real
    try {
      const io = getIo();
      io.emit("preagendamento:canceled", {
        preAgendamentoId: String(preAgendamento._id),
        externalId: preAgendamento.externalId,
        appointmentId: preAgendamento.importedToAppointment,
        patientName: preAgendamento.patientInfo?.fullName,
        timestamp: new Date()
      });
      console.log(`📡 Socket emitido: preagendamento:canceled ${preAgendamento._id}`);
    } catch (socketError) {
      console.error("⚠️ Erro ao emitir socket:", socketError.message);
    }

    return res.json({
      success: true,
      message: "Cancelamento sincronizado com sucesso",
      preAgendamentoId: preAgendamento._id,
      appointmentId: preAgendamento.importedToAppointment || null
    });

  } catch (error) {
    await session.abortTransaction();
    console.error("[SYNC-CANCEL] Erro:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
      code: "SYNC_CANCEL_ERROR"
    });
  } finally {
    session.endSession();
  }
});

/**
 * POST /api/import-from-agenda/sync-update
 * Atualiza (edita) um agendamento vindo da agenda externa
 */
router.post("/import-from-agenda/sync-update", agendaAuth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const {
      externalId,
      date,
      time,
      professionalName,
      specialty,
      patientInfo,
      observations,
      status // novo status (Pendente, Confirmado, etc)
    } = req.body;

    if (!externalId) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, error: "externalId é obrigatório" });
    }

    console.log(`[SYNC-UPDATE] Atualizando agendamento externo: ${externalId}`);

    // 1) Buscar pré-agendamento
    const preAgendamento = await PreAgendamento.findOne({ externalId }).session(session);

    if (!preAgendamento) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        error: "Pré-agendamento não encontrado",
        externalId
      });
    }

    // 2) Atualizar dados do pré-agendamento
    if (date) preAgendamento.preferredDate = date;
    if (time) preAgendamento.preferredTime = time;
    if (professionalName) preAgendamento.professionalName = professionalName;
    if (specialty) preAgendamento.specialty = specialty.toLowerCase();
    if (observations) {
      preAgendamento.secretaryNotes += `\n[ATUALIZADO VIA AGENDA EXTERNA - ${new Date().toLocaleString("pt-BR")}]: ${observations}`;
    }

    // Atualizar info do paciente se fornecida
    if (patientInfo) {
      if (patientInfo.fullName) preAgendamento.patientInfo.fullName = patientInfo.fullName;
      if (patientInfo.phone) preAgendamento.patientInfo.phone = patientInfo.phone.replace(/\D/g, "");
      if (patientInfo.email) preAgendamento.patientInfo.email = patientInfo.email;
      if (patientInfo.birthDate) preAgendamento.patientInfo.birthDate = patientInfo.birthDate;
    }

    await preAgendamento.save({ session });

    // 3) Se já foi importado, atualizar o agendamento real também
    let updatedAppointment = null;
    if (preAgendamento.importedToAppointment) {
      const appointment = await Appointment.findById(preAgendamento.importedToAppointment)
        .populate("session payment")
        .session(session);

      // Adicione esta verificação:
      if (appointment.session) {
        const sessionUpdate = {};
        if (date) sessionUpdate.date = date;
        if (time) sessionUpdate.time = time;
        if (professionalName && updateData.doctor) sessionUpdate.doctor = updateData.doctor;
        if (specialty) sessionUpdate.specialty = specialty.toLowerCase();
        if (observations) sessionUpdate.notes = observations;
        sessionUpdate.updatedAt = new Date();

        await Session.findByIdAndUpdate(appointment.session, sessionUpdate, { session });
      }

      if (appointment) {
        const updateData = {
          updatedAt: new Date()
        };

        // Atualizar data/hora
        if (date) updateData.date = date;
        if (time) updateData.time = time;

        // Atualizar profissional se mudou
        if (professionalName) {
          const doctor = await findDoctorByName(professionalName);
          if (doctor) {
            updateData.doctor = doctor._id;
          }
        }

        // Atualizar especialidade
        if (specialty) {
          updateData.specialty = specialty.toLowerCase();
        }

        // Atualizar observações
        if (observations) {
          updateData.notes = observations;
        }

        // Atualizar status se fornecido
        if (status) {
          const statusMap = {
            "pendente": "scheduled",
            "confirmado": "confirmed",
            "cancelado": "canceled",  // ou "canceled" mesmo
            "pago": "confirmed"
          };

          const newOperationalStatus = statusMap[status.toLowerCase()];
          if (newOperationalStatus) {
            updateData.operationalStatus = newOperationalStatus;
            if (newOperationalStatus === "canceled") {
              updateData.paymentStatus = "canceled";
              updateData.visualFlag = "blocked";
            }
          }
        }

        // Adicionar ao histórico
        updateData.$push = {
          history: {
            action: "atualizacao_via_agenda_externa",
            changedBy: null,
            timestamp: new Date(),
            context: "operacional",
            details: { externalId, changes: Object.keys(updateData).filter(k => k !== "$push" && k !== "updatedAt") }
          }
        };

        updatedAppointment = await Appointment.findByIdAndUpdate(
          appointment._id,
          updateData,
          { new: true, session }
        );
        const io = getIo();
        if (updatedAppointment) {
          io.emit("appointmentUpdated", updatedAppointment);
        }


        // 4) Sincronizar Session relacionada
        if (appointment.session) {
          const sessionUpdate = {};
          if (date) sessionUpdate.date = date;
          if (time) sessionUpdate.time = time;
          if (professionalName && updateData.doctor) sessionUpdate.doctor = updateData.doctor;
          if (specialty) sessionUpdate.specialty = specialty.toLowerCase();
          if (observations) sessionUpdate.notes = observations;
          sessionUpdate.updatedAt = new Date();

          await Session.findByIdAndUpdate(appointment.session, sessionUpdate, { session });
        }

        console.log(`[SYNC-UPDATE] ✅ Agendamento ${appointment._id} atualizado`);
      }
    }

    await session.commitTransaction();

    console.log(`🚀 Tentando emitir socket: preagendamento:XXXX para externalId: ${externalId}`);

    // 5) Emitir socket
    try {
      const io = getIo();
      io.emit("preagendamento:updated", {
        preAgendamentoId: String(preAgendamento._id),
        externalId: preAgendamento.externalId,
        appointmentId: preAgendamento.importedToAppointment,
        patientName: preAgendamento.patientInfo?.fullName,
        changes: { date, time, professionalName, specialty, status },
        timestamp: new Date()
      });
      console.log(`📡 Socket emitido: preagendamento:updated ${preAgendamento._id}`);
    } catch (socketError) {
      console.error("⚠️ Erro ao emitir socket:", socketError.message);
    }

    return res.json({
      success: true,
      message: "Atualização sincronizada com sucesso",
      preAgendamentoId: preAgendamento._id,
      appointmentId: preAgendamento.importedToAppointment || null,
      updatedFields: { date, time, professionalName, specialty, status }
    });

  } catch (error) {
    await session.abortTransaction();
    console.error("[SYNC-UPDATE] Erro:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
      code: "SYNC_UPDATE_ERROR"
    });
  } finally {
    session.endSession();
  }
});

/**
 * POST /api/import-from-agenda/sync-delete
 * Exclui (deleta permanentemente) um agendamento vindo da agenda externa
 */
router.post("/import-from-agenda/sync-delete", agendaAuth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { externalId, reason = "Excluído via agenda externa" } = req.body;

    if (!externalId) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, error: "externalId é obrigatório" });
    }

    console.log(`[SYNC-DELETE] Excluindo agendamento externo: ${externalId}`);

    // 1) Buscar pré-agendamento
    const preAgendamento = await PreAgendamento.findOne({ externalId }).session(session);

    if (!preAgendamento) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        error: "Pré-agendamento não encontrado",
        externalId
      });
    }

    const appointmentId = preAgendamento.importedToAppointment;
    let deletedAppointment = null;

    // 2) Se tem agendamento importado, deletar em cascata
    if (appointmentId) {
      const appointment = await Appointment.findById(appointmentId).session(session);

      if (appointment) {
        // Deletar Session relacionada
        if (appointment.session) {
          await Session.findByIdAndDelete(appointment.session).session(session);
          console.log(`[SYNC-DELETE] Session ${appointment.session} deletada`);
        }

        // Deletar Payment relacionado (se não for parte de pacote)
        if (appointment.payment) {
          const payment = await Payment.findById(appointment.payment).session(session);
          if (payment && payment.kind !== "package_receipt") {
            await Payment.findByIdAndDelete(appointment.payment).session(session);
            console.log(`[SYNC-DELETE] Payment ${appointment.payment} deletado`);
          }
        }

        // Remover referência do paciente
        if (appointment.patient) {
          await Patient.findByIdAndUpdate(
            appointment.patient,
            { $pull: { appointments: appointment._id } },
            { session }
          );
        }

        // Deletar o appointment
        await Appointment.findByIdAndDelete(appointment._id).session(session);
        deletedAppointment = appointment;
        console.log(`[SYNC-DELETE] Appointment ${appointment._id} deletado`);
      }
    }

    // 3) Deletar o pré-agendamento
    await PreAgendamento.findByIdAndDelete(preAgendamento._id).session(session);
    console.log(`[SYNC-DELETE] PreAgendamento ${preAgendamento._id} deletado`);

    await session.commitTransaction();

    console.log(`🚀 Tentando emitir socket: preagendamento:XXXX para externalId: ${externalId}`);

    // 4) Emitir socket
    try {
      const io = getIo();
      io.emit("preagendamento:deleted", {
        preAgendamentoId: String(preAgendamento._id),
        externalId: preAgendamento.externalId,
        appointmentId: appointmentId,
        patientName: preAgendamento.patientInfo?.fullName,
        reason,
        timestamp: new Date()
      });
      console.log(`📡 Socket emitido: preagendamento:deleted ${preAgendamento._id}`);
    } catch (socketError) {
      console.error("⚠️ Erro ao emitir socket:", socketError.message);
    }

    return res.json({
      success: true,
      message: "Exclusão sincronizada com sucesso",
      deletedPreAgendamentoId: preAgendamento._id,
      deletedAppointmentId: appointmentId,
      patientName: preAgendamento.patientInfo?.fullName
    });

  } catch (error) {
    await session.abortTransaction();
    console.error("[SYNC-DELETE] Erro:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
      code: "SYNC_DELETE_ERROR"
    });
  } finally {
    session.endSession();
  }
});

/**
 * GET /api/import-from-agenda/appointments-amanda
 * Retorna appointments agendados pela Amanda (source: amandaAI)
 * para a agenda externa mostrar como "pendentes de confirmação"
 */
router.get("/import-from-agenda/appointments-amanda", agendaAuth, async (req, res) => {
  try {
    const { date, doctorId, status } = req.query;

    const filter = {
      'metadata.origin.source': 'amandaAI',
      operationalStatus: { $nin: ['canceled', 'cancelado', 'cancelada'] }
    };

    if (date) {
      filter.date = date;
    }

    if (doctorId) {
      filter.doctor = doctorId;
    }

    if (status) {
      filter.operationalStatus = status;
    }

    const appointments = await Appointment.find(filter)
      .populate('patient', 'fullName phone dateOfBirth')
      .populate('doctor', 'fullName specialty')
      .populate('session', 'sessionType')
      .sort({ date: 1, time: 1 })
      .lean();

    console.log(`[APPOINTMENTS-AMANDA] Encontrados ${appointments.length} appointments da Amanda`);

    // Mapear para formato da agenda externa
    const mapped = appointments.map(appt => ({
      appointmentId: appt._id,
      externalId: `AMANDA-${appt._id}`, // ID único para agenda externa
      status: appt.operationalStatus === 'scheduled' ? 'pendente_confirmacao' : appt.operationalStatus,
      date: appt.date,
      time: appt.time,
      professionalName: appt.doctor?.fullName,
      professionalId: appt.doctor?._id,
      specialty: appt.doctor?.specialty || appt.specialty,
      patientInfo: {
        fullName: appt.patient?.fullName,
        phone: appt.patient?.phone,
        birthDate: appt.patient?.dateOfBirth
      },
      sessionType: appt.session?.sessionType || appt.sessionType,
      notes: appt.notes,
      createdAt: appt.createdAt,
      source: 'amanda_ai',
      isPending: appt.operationalStatus === 'scheduled', // Amanda agendou mas secretária ainda não confirmou
      canConfirm: true,
      canCancel: true
    }));

    return res.json({
      success: true,
      count: mapped.length,
      appointments: mapped
    });

  } catch (error) {
    console.error('[APPOINTMENTS-AMANDA] Erro:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/import-from-agenda/confirmar-agendamento
 * Confirma um pré-agendamento (muda de pre-scheduled → scheduled)
 */
router.post("/import-from-agenda/confirmar-agendamento", agendaAuth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { externalId, preAgendamentoId } = req.body;

    if (!externalId && !preAgendamentoId) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        error: "externalId ou preAgendamentoId é obrigatório"
      });
    }

    console.log(`[CONFIRMAR-AGENDAMENTO] Confirmando: ${externalId || preAgendamentoId}`);

    // Buscar PreAgendamento
    const query = externalId ? { externalId } : { _id: preAgendamentoId };
    const preAgendamento = await PreAgendamento.findOne(query).session(session);

    if (!preAgendamento) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        error: "Pré-agendamento não encontrado",
        query
      });
    }

    // Verificar se já foi importado
    if (preAgendamento.status !== 'importado' || !preAgendamento.importedToAppointment) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        error: "Pré-agendamento ainda não foi importado para appointment",
        status: preAgendamento.status
      });
    }

    // Buscar Appointment
    const appointment = await Appointment.findById(preAgendamento.importedToAppointment).session(session);

    if (!appointment) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        error: "Appointment não encontrado",
        appointmentId: preAgendamento.importedToAppointment
      });
    }

    // Verificar se já está confirmado
    if (appointment.operationalStatus === 'scheduled') {
      await session.commitTransaction();
      return res.json({
        success: true,
        message: "Agendamento já estava confirmado",
        appointmentId: appointment._id,
        preAgendamentoId: preAgendamento._id,
        status: 'already_confirmed'
      });
    }

    // CONFIRMAR: pre-scheduled → scheduled
    appointment.operationalStatus = 'scheduled';
    appointment.status = 'scheduled';
    appointment.updatedAt = new Date();

    if (!appointment.history) appointment.history = [];
    appointment.history.push({
      action: 'confirmacao_manual',
      changedBy: null,
      timestamp: new Date(),
      context: 'operacional',
      details: {
        from: 'pre-scheduled',
        to: 'scheduled',
        method: 'api_confirmar_agendamento'
      }
    });

    await appointment.save({ session });

    // Atualizar Session se existir
    if (appointment.session) {
      await Session.findByIdAndUpdate(
        appointment.session,
        {
          $set: {
            status: 'scheduled',
            updatedAt: new Date()
          }
        },
        { session }
      );
    }

    await session.commitTransaction();

    console.log(`[CONFIRMAR-AGENDAMENTO] ✅ Appointment ${appointment._id} confirmado`);

    // Emitir socket
    try {
      const io = getIo();
      io.emit("appointmentUpdated", appointment);
      io.emit("preagendamento:confirmed", {
        preAgendamentoId: String(preAgendamento._id),
        appointmentId: appointment._id,
        externalId: preAgendamento.externalId,
        patientName: preAgendamento.patientInfo?.fullName,
        timestamp: new Date()
      });
      console.log(`📡 Socket emitido: preagendamento:confirmed ${preAgendamento._id}`);
    } catch (socketError) {
      console.error("⚠️ Erro ao emitir socket:", socketError.message);
    }

    return res.json({
      success: true,
      message: "Pré-agendamento confirmado com sucesso!",
      appointmentId: appointment._id,
      preAgendamentoId: preAgendamento._id,
      externalId: preAgendamento.externalId,
      status: 'confirmed'
    });

  } catch (error) {
    await session.abortTransaction();
    console.error("[CONFIRMAR-AGENDAMENTO] Erro:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
      code: "CONFIRM_ERROR"
    });
  } finally {
    session.endSession();
  }
});

export default router;