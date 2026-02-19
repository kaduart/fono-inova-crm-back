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
 * 🔍 Helper: Encontra ou cria paciente de forma segura
 * Usado quando os dados da migração não bateram corretamente
 */
async function findOrCreatePatient(patientInfo, session) {
  try {
    const cleanPhone = (patientInfo?.phone || "").replace(/\D/g, "");
    const fullName = patientInfo?.fullName?.trim();

    if (!cleanPhone && !fullName) {
      console.log(`[findOrCreatePatient] ⚠️ Dados insuficientes do paciente`);
      return null;
    }

    // 1) Tentar encontrar por telefone (mais confiável)
    let patient = null;
    if (cleanPhone && cleanPhone.length >= 10) {
      patient = await Patient.findOne({ phone: cleanPhone }).session(session);
      if (patient) {
        console.log(`[findOrCreatePatient] ✅ Encontrado por telefone: ${patient._id}`);
        return patient;
      }
    }

    // 2) Tentar encontrar por nome + telefone parcial
    if (fullName) {
      const nameQuery = { fullName: { $regex: new RegExp(fullName, 'i') } };
      if (cleanPhone && cleanPhone.length >= 8) {
        nameQuery.phone = { $regex: cleanPhone.slice(-8) }; // Últimos 8 dígitos
      }
      patient = await Patient.findOne(nameQuery).session(session);
      if (patient) {
        console.log(`[findOrCreatePatient] ✅ Encontrado por nome+telefone: ${patient._id}`);
        return patient;
      }
    }

    // 3) Se não encontrou e tem dados suficientes, criar novo paciente
    if (fullName && cleanPhone && cleanPhone.length >= 10) {
      console.log(`[findOrCreatePatient] 🔄 Criando novo paciente: ${fullName}`);

      patient = await Patient.create([{
        fullName: fullName,
        phone: cleanPhone,
        email: patientInfo?.email || undefined,
        dateOfBirth: patientInfo?.birthDate || undefined,
        source: 'agenda_externa_migration'
      }], { session });

      console.log(`[findOrCreatePatient] ✅ Paciente criado: ${patient[0]._id}`);
      return patient[0];
    }

    console.log(`[findOrCreatePatient] ⚠️ Não encontrou nem criou paciente`);
    return null;
  } catch (error) {
    console.error(`[findOrCreatePatient] ❌ Erro:`, error.message);
    return null;
  }
}


/**
 * POST /api/import-from-agenda
 * Recebe da agenda externa e cria PRE-AGENDAMENTO
 */
router.post("/import-from-agenda", agendaAuth, async (req, res) => {
  try {
    // Dados direto no formato MongoDB
    const {
      _id,
      professionalName,
      date,
      time,
      specialty,
      patientInfo,
      responsible,
      observations,
      crm: crmRaw,
    } = req.body;

    // _id é opcional - se não vier, o MongoDB gera automaticamente
    // Se vier, salvamos em externalId para rastreamento
    const crm = crmRaw || {};
    const cleanPhone = (patientInfo?.phone || "").replace(/\D/g, "");

    // 1) Buscar doutor
    const doctor = await findDoctorByName(professionalName);

    // 2) Verificar se paciente já existe (não cria agora se for lead novo)
    let patientId = null;
    try {
      // Normaliza o telefone antes da busca
      const phoneToSearch = cleanPhone;

      if (phoneToSearch && phoneToSearch.length >= 8) {
        // Tenta encontrar por telefone
        const existingPatient = await Patient.findOne({
          phone: { $regex: phoneToSearch.slice(-10) } // Busca pelos últimos 10 dígitos para maior flexibilidade
        }).select('_id').lean();

        if (existingPatient) {
          patientId = existingPatient._id;
          console.log(`[IMPORT-FROM-AGENDA] ✅ Paciente encontrado: ${patientId}`);
        }
      }

      // Se não achou por telefone, tenta por nome (opcional, mas bom para leads que viraram pacientes)
      if (!patientId && patientInfo?.fullName) {
        const existingByName = await Patient.findOne({
          fullName: { $regex: new RegExp(`^${patientInfo.fullName.trim()}$`, 'i') }
        }).select('_id').lean();

        if (existingByName) {
          patientId = existingByName._id;
          console.log(`[IMPORT-FROM-AGENDA] ✅ Paciente encontrado por nome: ${patientId}`);
        }
      }
    } catch (searchError) {
      console.error("[IMPORT-FROM-AGENDA] Erro ao buscar paciente:", searchError.message);
    }

    // 3) Criar PRÉ-AGENDAMENTO (_id gerado automaticamente pelo MongoDB)
    const preAgendamentoData = {
      source: 'agenda_externa',
      // Se _id foi enviado, salva em externalId para rastreamento
      ...( _id ? { externalId: _id } : {}),
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
    };

    const preAgendamento = await PreAgendamento.create(preAgendamentoData);

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
 * POST /api/import-from-agenda/confirmar-por-id
 * Confirma usando o _id
 */
router.post("/import-from-agenda/confirmar-por-id", agendaAuth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const {
      _id,
      doctorId,
      date,
      time,
      sessionValue,
      serviceType = 'evaluation',
      paymentMethod = 'pix',
      notes
    } = req.body;

    if (!_id) {
      return res.status(400).json({ success: false, error: '_id é obrigatório' });
    }

    console.log(`[CONFIRMAR-POR-ID] Buscando pré-agendamento: ${_id}`);

    const pre = await PreAgendamento.findById(_id).session(session);

    if (!pre) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        error: 'Pré-agendamento não encontrado',
        _id
      });
    }

    if (pre.status === 'importado') {
      console.log('[SYNC-UPDATE] 📋 updateData:', updateData);
    console.log('[SYNC-UPDATE] 📋 doctor encontrado:', doctor ? doctor._id : 'null');
    
    await session.commitTransaction();
    console.log('[SYNC-UPDATE] ✅ Commit realizado');

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
      status: 'scheduled', // Alterado de 'pre-scheduled' para 'scheduled' conforme solicitação
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
    pre.patientId = result.patientId; // ✅ Garante o vínculo final
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
      _id,
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

    console.log(`[CRIAR-E-CONFIRMAR] Iniciando: ${patientInfo?.fullName} (${_id})`);

    // 🔍 Verificar se já existe PreAgendamento com este _id
    const existingPre = await PreAgendamento.findById(_id).session(session);

    if (existingPre) {
      console.log(`[CRIAR-E-CONFIRMAR] ⚠️ PreAgendamento ${existingPre._id} já existe`);

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

          // Se está scheduled, vamos confirmar agora (caso venha de um pré-agendamento anterior)
          if (existingAppointment.operationalStatus === 'scheduled') {
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
              details: { from: 'scheduled', to: 'scheduled' }
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
        _id,
        source: 'agenda_externa',
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
      status: 'scheduled', // Alterado de 'pre-scheduled' para 'scheduled' conforme solicitação
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
    pre.patientId = result.patientId; // ✅ Garante o vínculo final
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
      patientId: result.patientId
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
 * 
 * NOTA: Fonte única de verdade: MongoDB.
 */
router.post("/import-from-agenda/sync-cancel", agendaAuth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { _id, reason = "Cancelado via agenda externa", confirmedAbsence = false } = req.body;

    if (!_id) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, error: "_id é obrigatório" });
    }

    console.log(`[SYNC-CANCEL] Cancelando agendamento: ${_id}`);

    // Buscar appointment direto pelo _id
    const appointment = await Appointment.findById(_id)
      .populate("session payment patient")
      .session(session);

    if (!appointment) {
      console.log(`[SYNC-CANCEL] ❌ Appointment não encontrado: ${_id}`);
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        error: "Agendamento não encontrado",
        _id
      });
    }

    console.log(`[SYNC-CANCEL] ✅ Appointment encontrado: ${appointment._id}`);

    // Verificar se já está cancelado
    if (appointment.operationalStatus === 'canceled') {
      console.log(`[SYNC-CANCEL] ℹ️ Appointment ${appointment._id} já está cancelado`);
      await session.commitTransaction();
      return res.json({
        success: true,
        message: "Agendamento já estava cancelado",
        appointmentId: appointment._id,
        externalId,
        status: 'already_canceled'
      });
    }

    // 2) Cancelar o agendamento
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

    await session.commitTransaction();

    // 3) Emitir socket
    try {
      const io = getIo();
      io.emit("appointmentUpdated", {
        _id: appointment._id,
        operationalStatus: "canceled"
      });
      console.log(`📡 Socket emitido: appointmentUpdated ${appointment._id}`);
    } catch (socketError) {
      console.error("⚠️ Erro ao emitir socket:", socketError.message);
    }

    return res.json({
      success: true,
      message: "Cancelamento sincronizado com sucesso",
      appointmentId: appointment._id,
      _id
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
 * 
 * NOTA: Fonte única de verdade: MongoDB.
 * externalId é apenas referência histórica, não chave primária.
 */
router.post("/import-from-agenda/sync-update", agendaAuth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const {
      _id,
      date,
      time,
      professionalName,
      specialty,
      patientInfo,
      observations,
      status,
      operationalStatus,
      crm: crmRaw
    } = req.body;

    const crm = crmRaw || {};
    
    // 🗺️ MAPEAMENTO DE CAMPOS: formato agenda externa → formato CRM interno
    const mappedData = {
      // IDs
      doctorId: doctor?._id || null,
      patientId: appointment?.patient?.toString() || null,
      
      // Dados básicos
      date: date,
      time: time,
      specialty: specialty?.toLowerCase(),
      notes: observations,
      operationalStatus: operationalStatus || (status === 'Pendente' ? 'scheduled' : status?.toLowerCase()),
      
      // Dados financeiros
      paymentAmount: Number(crm.paymentAmount || 0),
      paymentMethod: crm.paymentMethod || 'pix',
      amount: Number(crm.paymentAmount || 0), // compatibilidade
      billingType: 'particular', // default
      
      // Dados da sessão
      sessionType: crm.sessionType || 'avaliacao',
      serviceType: crm.serviceType === 'session' ? 'session' : 'evaluation',
      sessionStatus: operationalStatus,
      
      // Dados do paciente
      patientName: patientInfo?.fullName,
      patientPhone: patientInfo?.phone,
      patientBirthDate: patientInfo?.birthDate,
      patientEmail: patientInfo?.email,
      
      // Outros
      responsible: responsible,
      updatedAt: new Date()
    };
    
    console.log('[SYNC-UPDATE] 🗺️ Dados mapeados:', mappedData);

    if (!_id) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, error: "_id é obrigatório" });
    }

    console.log(`[SYNC-UPDATE] Atualizando agendamento: ${_id}`);

    // 1) Tentar encontrar em Appointment primeiro
    let appointment = await Appointment.findById(_id).session(session);
    let isPreAgendamento = false;
    let preAgendamento = null;

    if (!appointment) {
      // Se não encontrou, tentar em PreAgendamento
      console.log(`[SYNC-UPDATE] ⚠️ Appointment não encontrado, tentando PreAgendamento: ${_id}`);
      preAgendamento = await PreAgendamento.findById(_id).session(session);
      
      if (preAgendamento) {
        isPreAgendamento = true;
        console.log(`[SYNC-UPDATE] ✅ PreAgendamento encontrado: ${preAgendamento._id}`);
      } else {
        console.log(`[SYNC-UPDATE] ❌ Não encontrado em Appointment nem PreAgendamento: ${_id}`);
        await session.abortTransaction();
        return res.status(404).json({
          success: false,
          error: "Agendamento não encontrado",
          _id
        });
      }
    } else {
      console.log(`[SYNC-UPDATE] ✅ Appointment encontrado: ${appointment._id}`);
    }

    // OTIMIZAÇÃO: Se for agendamento antigo (>7 dias) e já concluído, não gasta recursos
    if (['paid', 'confirmed', 'completed'].includes(appointment.operationalStatus) &&
      new Date(appointment.date) < new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)) {
      console.log(`[SYNC-UPDATE] ℹ️ Appointment ${appointment._id} já concluído há mais de 7 dias, ignorando update`);
      await session.commitTransaction();
      return res.json({ success: true, message: "Histórico preservado", status: 'archived' });
    }

    const updateData = { updatedAt: new Date() };
    if (date) updateData.date = date;
    if (time) updateData.time = time;
    if (observations) updateData.notes = observations;
    if (specialty) updateData.specialty = specialty.toLowerCase();

    // Prioridade para operationalStatus (unificado)
    if (operationalStatus) {
      updateData.operationalStatus = operationalStatus;
    } else if (status) {
      const statusMap = { "pendente": "scheduled", "confirmado": "confirmed", "cancelado": "canceled", "pago": "confirmed", "faltou": "missed" };
      const mapped = statusMap[status.toLowerCase()];
      if (mapped) updateData.operationalStatus = mapped;
    }

    let doctor = null;
    if (professionalName) {
      doctor = await findDoctorByName(professionalName);
      if (doctor) updateData.doctor = doctor._id;
    }


    // SE FOR PRÉ-AGENDAMENTO: atualização simplificada
    if (isPreAgendamento && preAgendamento) {
      const preUpdateData = { updatedAt: new Date() };
      if (date) preUpdateData.preferredDate = date;
      if (time) preUpdateData.preferredTime = time;
      if (specialty) preUpdateData.specialty = specialty.toLowerCase();
      if (observations) preUpdateData.secretaryNotes = observations;
      if (operationalStatus) preUpdateData.status = operationalStatus;
      
      // Atualizar patientInfo
      if (patientInfo) {
        preUpdateData.patientInfo = {
          ...preAgendamento.patientInfo,
          ...patientInfo
        };
      }
      
      // Atualizar professional
      if (doctor) {
        preUpdateData.professionalId = doctor._id;
        preUpdateData.professionalName = doctor.fullName;
      }
      
      const updatedPre = await PreAgendamento.findByIdAndUpdate(
        preAgendamento._id,
        { $set: preUpdateData },
        { new: true, session }
      );
      
      await session.commitTransaction();
      
      // Emitir socket
      try {
        const io = getIo();
        io.emit("preagendamento:updated", updatedPre);
        console.log(`📡 Socket emitido: preagendamento:updated ${updatedPre._id}`);
      } catch (socketError) {
        console.error("⚠️ Erro ao emitir socket:", socketError.message);
      }
      
      return res.json({
        success: true,
        message: "Pré-agendamento atualizado com sucesso",
        appointmentId: preAgendamento._id,
        isPreAgendamento: true
      });
    }

    // SE FOR APPOINTMENT REAL: atualização completa
    // 2) Atualizar Patient (nome, telefone, etc.)
    if (appointment.patient && patientInfo) {
      const patientUpdate = {};
      if (patientInfo.fullName) {
        // Limpar nome (remover quebras de linha e espaços extras)
        patientUpdate.fullName = patientInfo.fullName.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
      }
      if (patientInfo.phone) patientUpdate.phone = patientInfo.phone;
      if (patientInfo.birthDate) patientUpdate.dateOfBirth = patientInfo.birthDate;
      if (patientInfo.email) patientUpdate.email = patientInfo.email;
      patientUpdate.updatedAt = new Date();
      
      if (Object.keys(patientUpdate).length > 0) {
        await Patient.findByIdAndUpdate(appointment.patient, patientUpdate, { session });
        console.log(`[SYNC-UPDATE] ✅ Patient ${appointment.patient} atualizado`);
      }
    }

    // 3) Atualizar Sessão relacionada (mesma lógica do appointments.js)
    if (appointment.session) {
      await Session.findByIdAndUpdate(
        appointment.session,
        {
          $set: {
            date: date || appointment.date,
            time: time || appointment.time,
            doctor: doctor?._id || appointment.doctor,
            specialty: specialty?.toLowerCase() || appointment.specialty,
            notes: observations || appointment.notes,
            status: operationalStatus || appointment.operationalStatus,
            updatedAt: new Date()
          }
        },
        { session }
      );
      console.log(`[SYNC-UPDATE] ✅ Session ${appointment.session} atualizada`);
    }

    // 4) Atualizar Pagamento relacionado (mesma lógica do appointments.js)
    if (appointment.payment) {
      await Payment.findByIdAndUpdate(
        appointment.payment,
        {
          $set: {
            doctor: doctor?._id || appointment.doctor,
            amount: crm.paymentAmount || appointment.paymentAmount,
            paymentMethod: crm.paymentMethod || appointment.paymentMethod,
            serviceDate: date || appointment.date,
            updatedAt: new Date()
          }
        },
        { session }
      );
      console.log(`[SYNC-UPDATE] ✅ Payment ${appointment.payment} atualizado`);
    }

    // 5) Atualizar Appointment principal
    const updatedAppointment = await Appointment.findByIdAndUpdate(
      appointment._id,
      {
        $set: updateData,
        $push: {
          history: {
            action: "sync_externo_completo",
            timestamp: new Date(),
            details: { source: 'agenda_externa', operationalStatus: updateData.operationalStatus }
          }
        }
      },
      { new: true, session }
    ).populate('patient doctor session payment');
    
    console.log('[SYNC-UPDATE] 📋 updatedAppointment:', {
      _id: updatedAppointment._id,
      date: updatedAppointment.date,
      time: updatedAppointment.time,
      doctor: updatedAppointment.doctor?._id,
      notes: updatedAppointment.notes
    });

    await session.commitTransaction();



    console.log(`[SYNC-UPDATE] ✅ Agendamento ${appointment._id} atualizado`);


    // 4) Emitir socket
    try {
      const io = getIo();
      io.emit("appointmentUpdated", updatedAppointment);
      console.log(`📡 Socket emitido: appointmentUpdated ${appointment._id}`);
    } catch (socketError) {
      console.error("⚠️ Erro ao emitir socket:", socketError.message);
    }

    return res.json({
      success: true,
      message: "Atualização sincronizada com sucesso",
      appointmentId: appointment._id,
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
 * 
 * NOTA: Fonte única de verdade: MongoDB.
 */
router.post("/import-from-agenda/sync-delete", agendaAuth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { _id, reason = "Excluído via agenda externa" } = req.body;

    if (!_id) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, error: "_id é obrigatório" });
    }

    console.log(`[SYNC-DELETE] Excluindo agendamento: ${_id}`);

    // Buscar appointment direto pelo _id
    const appointment = await Appointment.findById(_id)
      .populate("patient")
      .session(session);

    if (!appointment) {
      console.log(`[SYNC-DELETE] ❌ Appointment não encontrado: ${_id}`);
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        error: "Agendamento não encontrado",
        _id
      });
    }

    console.log(`[SYNC-DELETE] ✅ Appointment encontrado: ${appointment._id}`);

    // 2) Deletar em cascata
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
    console.log(`[SYNC-DELETE] Appointment ${appointment._id} deletado`);

    // 3) Se houver PreAgendamento com mesmo _id, deletar também
    const preAgendamento = await PreAgendamento.findById(_id).session(session);
    if (preAgendamento) {
      await PreAgendamento.findByIdAndDelete(preAgendamento._id).session(session);
      console.log(`[SYNC-DELETE] PreAgendamento ${preAgendamento._id} deletado`);
    }

    await session.commitTransaction();

    // 4) Emitir socket
    try {
      const io = getIo();
      io.emit("appointmentDeleted", {
        appointmentId: appointment._id,
        externalId,
        reason,
        timestamp: new Date()
      });
      console.log(`📡 Socket emitido: appointmentDeleted ${appointment._id}`);
    } catch (socketError) {
      console.error("⚠️ Erro ao emitir socket:", socketError.message);
    }

    return res.json({
      success: true,
      message: "Exclusão sincronizada com sucesso",
      appointmentId: appointment._id,
      externalId,
      note: "Fonte única de verdade: MongoDB"
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
 * Confirma um pré-agendamento (muda de scheduled → confirmed/scheduled conforme lógica)
 */
router.post("/import-from-agenda/confirmar-agendamento", agendaAuth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { _id } = req.body;

    if (!_id) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        error: "_id é obrigatório"
      });
    }

    console.log(`[CONFIRMAR-AGENDAMENTO] Confirmando: ${_id}`);

    // Buscar PreAgendamento
    const preAgendamento = await PreAgendamento.findById(_id).session(session);

    if (!preAgendamento) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        error: "Pré-agendamento não encontrado",
        _id
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

    // CONFIRMAR: scheduled → confirmed (ou manter scheduled se for apenas atualização)
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
        from: 'scheduled',
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