import axios from "axios";
import express from "express";
import mongoose from "mongoose";
import { agendaAuth } from "../middleware/agendaAuth.js";
import { getIo } from "../config/socket.js"; 
import Doctor from "../models/Doctor.js";
import Package from "../models/Package.js";
import { bookFixedSlot, fetchAvailableSlotsForDoctor } from "../services/amandaBookingService.js";
import { findDoctorByName } from "../utils/doctorHelper.js";
import { calculateAvailableSlots } from "../middleware/conflictDetection.js";

import Appointment from "../models/Appointment.js";
import Session from "../models/Session.js";
import Payment from "../models/Payment.js";
import Patient from "../models/Patient.js";

const router = express.Router();

const API_BASE = process.env.API_BASE || "http://localhost:5000";


/**
 * POST /api/agenda-externa/pre-agendar
 * Cria um Appointment com operationalStatus: 'pre_agendado' vindo da agenda externa
 */
router.post("/agenda-externa/pre-agendar", agendaAuth, async (req, res) => {
  try {
    // Dados direto no formato MongoDB
    const {
      _id,
      professionalName,
      date,
      time,
      specialty,
      patientInfo,
      patientId: patientIdRaw,
      isNewPatient,
      responsible,
      observations,
      billingType,
      insuranceProvider,
      insuranceValue,
      authorizationCode,
      crm: crmRaw,
    } = req.body;

    const crm = crmRaw || {};
    const cleanPhone = (patientInfo?.phone || "").replace(/\D/g, "");

    // Resolver patient: obrigatório — usa existente ou cria novo
    let resolvedPatientId = null;
    if (patientIdRaw && mongoose.Types.ObjectId.isValid(patientIdRaw)) {
      resolvedPatientId = patientIdRaw;
    } else if (isNewPatient && patientInfo?.fullName) {
      const created = await Patient.create({
        fullName: patientInfo.fullName,
        phone: cleanPhone || undefined,
        email: patientInfo.email || undefined,
        dateOfBirth: patientInfo.birthDate || undefined,
        source: 'agenda_externa'
      });
      resolvedPatientId = created._id;
    } else {
      return res.status(400).json({
        success: false,
        error: 'Informe patientId (paciente existente) ou isNewPatient: true para criar novo paciente'
      });
    }

    // 1) Buscar doutor
    const doctor = await findDoctorByName(professionalName);

    // 2) Verificar duplicatas por (phone + date + time) e (doutor + date + time)
    if (date && time) {
      const activeStatuses = ['pre_agendado', 'scheduled', 'confirmed', 'paid'];

      // 3a) Mesmo paciente (telefone) no mesmo slot
      if (cleanPhone) {
        const existingPatientSlot = await Appointment.findOne({
          'patientInfo.phone': { $regex: cleanPhone.slice(-10) },
          date,
          time,
          operationalStatus: { $in: activeStatuses }
        }).lean();

        if (existingPatientSlot) {
          console.log(`[IMPORT-FROM-AGENDA] ⏭️ Duplicata paciente (${existingPatientSlot.operationalStatus}): ${cleanPhone} ${date} ${time}`);
          return res.json({
            success: true,
            skipped: true,
            message: 'Paciente já possui agendamento neste slot',
            appointmentId: existingPatientSlot._id,
            preAgendamentoId: existingPatientSlot._id
          });
        }
      }

      // 3b) Mesmo doutor no mesmo slot (evita dupla reserva)
      // Checa por doctor._id OU professionalName (registros antigos podem não ter o ObjectId)
      if (doctor) {
        const doctorSlotQuery = {
          date,
          time,
          operationalStatus: { $in: activeStatuses },
          $or: [
            { doctor: doctor._id },
            { professionalName: { $regex: new RegExp(doctor.fullName.trim(), 'i') } }
          ]
        };

        const existingDoctorSlot = await Appointment.findOne(doctorSlotQuery).lean();

        if (existingDoctorSlot) {
          console.log(`[IMPORT-FROM-AGENDA] ⏭️ Conflito doutor ${doctor.fullName} (${existingDoctorSlot.operationalStatus}): ${date} ${time}`);
          return res.status(409).json({
            success: false,
            error: `${doctor.fullName} já possui agendamento neste horário (${date} às ${time})`,
            conflict: {
              appointmentId: existingDoctorSlot._id,
              operationalStatus: existingDoctorSlot.operationalStatus
            }
          });
        }
      }
    }

    // Criar APPOINTMENT
    const appointmentData = {
      patient: resolvedPatientId || undefined,
      doctor: doctor?._id || undefined,
      patientInfo: {
        fullName: patientInfo?.fullName,
        phone: cleanPhone,
        email: patientInfo?.email,
        birthDate: patientInfo?.birthDate
      },
      professionalName: professionalName || undefined,
      // Slot
      date,
      time,
      duration: 40,
      specialty: (specialty || doctor?.specialty || 'fonoaudiologia').toLowerCase(),
      // Tipo de atendimento
      serviceType: crm.serviceType || 'evaluation',
      sessionValue: Number(crm.paymentAmount || req.body.sessionValue || 0),
      paymentMethod: crm.paymentMethod || 'pix',
      billingType: billingType || 'particular',
      insuranceProvider: insuranceProvider || null,
      insuranceValue: Number(insuranceValue || 0),
      authorizationCode: authorizationCode || null,
      // Status — padrão CRM
      operationalStatus: 'pre_agendado',
      clinicalStatus: 'pending',
      paymentStatus: 'pending',
      visualFlag: 'pending',
      // Notas
      notes: observations || '',
      responsible: responsible || '',
      secretaryNotes: responsible ? `Responsável: ${responsible}` : '',
      // Origem
      metadata: { origin: { source: 'agenda_externa' } }
    };

    console.log(`[IMPORT-FROM-AGENDA] 💾 Criando Appointment (pre_agendado):`, {
      patient: patientInfo?.fullName,
      date, time, specialty,
      sessionValue: appointmentData.sessionValue
    });

    const appointment = await Appointment.create(appointmentData);

    console.log(`[IMPORT-FROM-AGENDA] ✅ Appointment criado: ${appointment._id}`);

    // ✅ Emitir socket
    try {
      const io = getIo();
      const socketData = {
        id: String(appointment._id),
        patientName: appointment.patientInfo.fullName,
        phone: appointment.patientInfo.phone,
        specialty: appointment.specialty,
        preferredDate: appointment.date,
        preferredTime: appointment.time,
        operationalStatus: 'pre_agendado',
        urgency: appointment.urgency,
        createdAt: appointment.createdAt,
        source: 'agenda_externa'
      };
      io.emit("preagendamento:new", socketData);
      io.emit("appointmentCreated", socketData);
      console.log(`📡 Socket emitido: preagendamento:new + appointmentCreated ${appointment._id}`);
    } catch (socketError) {
      console.error(`⚠️ Erro ao emitir socket:`, socketError.message);
    }

    return res.status(201).json({
      success: true,
      message: 'Pré-agendamento criado com sucesso!',
      appointmentId: appointment._id,
      preAgendamentoId: appointment._id, // compat agenda-clinica-web
      operationalStatus: 'pre_agendado',
      urgency: appointment.urgency,
      nextStep: 'Aguardando confirmação da secretária'
    });

  } catch (err) {
    console.error("[IMPORT_FROM_AGENDA] error:", err);
    return res.status(500).json({ success: false, code: "INTERNAL_ERROR", error: err.message });
  }
});

/**
 * POST /api/agenda-externa/confirmar
 * Confirma um Appointment pre_agendado — atualiza in-place (mesmo _id preservado)
 */
router.post("/agenda-externa/confirmar", agendaAuth, async (req, res) => {
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

    const pre = await Appointment.findById(_id);

    if (!pre) {
      return res.status(404).json({ success: false, error: 'Agendamento não encontrado', _id });
    }

    // Idempotente: já confirmado
    if (['scheduled', 'confirmed', 'paid'].includes(pre.operationalStatus)) {
      return res.json({
        success: true,
        message: 'Já foi confirmado anteriormente',
        appointmentId: pre._id,
        preAgendamentoId: pre._id,
        warning: 'Este agendamento já havia sido confirmado'
      });
    }

    if (pre.operationalStatus !== 'pre_agendado') {
      return res.status(400).json({ success: false, error: `Status inválido para confirmação: ${pre.operationalStatus}` });
    }

    // Resolver doutor
    let doctor = null;
    if (doctorId) doctor = await Doctor.findById(doctorId);
    if (!doctor && pre.professionalName) {
      const d = await findDoctorByName(pre.professionalName);
      if (d) doctor = await Doctor.findById(d._id);
    }
    if (!doctor) {
      return res.status(404).json({ success: false, error: `Doutor não encontrado. ID: ${doctorId}, Nome: ${pre.professionalName}` });
    }

    // Resolver paciente: usa existente ou cria novo pelo telefone
    let patientId = pre.patient || null;
    if (!patientId && pre.patientInfo?.phone) {
      const cleanPhone = pre.patientInfo.phone.replace(/\D/g, '');
      const existing = await Patient.findOne({ phone: { $regex: cleanPhone.slice(-10) } }).lean();
      if (existing) {
        patientId = existing._id;
      } else if (pre.patientInfo?.fullName) {
        const created = await Patient.create({
          fullName: pre.patientInfo.fullName,
          phone: cleanPhone || undefined,
          email: pre.patientInfo.email || undefined,
          dateOfBirth: pre.patientInfo.birthDate || undefined,
          source: 'agenda_externa'
        });
        patientId = created._id;
      }
    }

    // Classificar tipo de paciente (novo / retorno / recorrente)
    // Limiar: sem appointment real há mais de 6 meses = retorno
    const MONTHS_INACTIVE_THRESHOLD = 6;
    let patientType = null;
    let patientTypeMonthsInactive = null;
    if (patientId) {
      const lastReal = await Appointment.findOne({
        patient: patientId,
        operationalStatus: { $in: ['scheduled', 'confirmed', 'paid', 'missed'] },
        _id: { $ne: pre._id }
      }).sort({ date: -1 }).select('date').lean();

      if (!lastReal) {
        patientType = 'novo';
      } else {
        const lastDate = new Date(lastReal.date);
        const now = new Date();
        const diffMonths = (now.getFullYear() - lastDate.getFullYear()) * 12 +
          (now.getMonth() - lastDate.getMonth());
        patientTypeMonthsInactive = diffMonths;
        patientType = diffMonths >= MONTHS_INACTIVE_THRESHOLD ? 'retorno' : 'recorrente';
      }
    }

    const resolvedDate = date || pre.date;
    const resolvedTime = time || pre.time;
    const resolvedValue = Number(sessionValue || pre.sessionValue || 0);
    // 🚨 Nunca 'session' como serviceType — ativa modo payment fantasma
    const normalizedServiceType = serviceType === 'session' ? 'individual_session' : serviceType;
    const sessionType = serviceType === 'evaluation' ? 'avaliacao' : 'sessao';

    // Criar Session
    const newSession = await Session.create({
      patient: patientId,
      doctor: doctor._id,
      appointmentId: pre._id,
      sessionType,
      date: resolvedDate,
      time: resolvedTime,
      sessionValue: resolvedValue,
      status: 'scheduled',
      isPaid: false,
      paymentStatus: 'pending',
      visualFlag: 'pending',
      notes: notes || pre.notes || ''
    });

    // Criar Payment
    const newPayment = await Payment.create({
      patient: patientId,
      doctor: doctor._id,
      session: newSession._id,
      appointment: pre._id,
      serviceType: normalizedServiceType,
      amount: resolvedValue,
      paymentMethod,
      billingType: pre.billingType || 'particular',
      status: 'pending',
      paymentDate: resolvedDate,
      serviceDate: resolvedDate
    });

    await Session.findByIdAndUpdate(newSession._id, { paymentId: newPayment._id });

    // Atualizar Appointment in-place
    pre.operationalStatus = 'scheduled';
    pre.doctor = doctor._id;
    if (patientId) pre.patient = patientId;
    pre.date = resolvedDate;
    pre.time = resolvedTime;
    pre.sessionValue = resolvedValue;
    pre.paymentMethod = paymentMethod;
    pre.serviceType = normalizedServiceType;
    pre.session = newSession._id;
    pre.payment = newPayment._id;
    if (notes) pre.notes = notes;
    if (patientType) pre.patientType = patientType;
    if (patientTypeMonthsInactive !== null) pre.patientTypeMonthsInactive = patientTypeMonthsInactive;
    if (!pre.metadata) pre.metadata = {};
    if (!pre.metadata.origin) pre.metadata.origin = {};
    pre.metadata.origin.convertedAt = new Date();
    pre.history = pre.history || [];
    pre.history.push({
      action: 'confirmado_via_agenda_externa',
      newStatus: 'scheduled',
      changedBy: null,
      timestamp: new Date(),
      context: 'operacional'
    });

    await pre.save({ validateBeforeSave: false });

    console.log(`[CONFIRMAR] ✅ Appointment ${pre._id} atualizado in-place → scheduled`);

    try {
      const io = getIo();
      io.emit("appointmentUpdated", { _id: pre._id, operationalStatus: 'scheduled' });
      io.emit("preagendamento:imported", {
        preAgendamentoId: String(pre._id),
        appointmentId: String(pre._id),
        patientId,
        patientName: pre.patientInfo?.fullName,
        timestamp: new Date()
      });
    } catch (socketError) {
      console.error('⚠️ Erro ao emitir socket:', socketError.message);
    }

    return res.json({
      success: true,
      message: 'Importado com sucesso!',
      appointmentId: pre._id,
      patientId,
      preAgendamentoId: pre._id
    });

  } catch (error) {
    console.error('[CONFIRMAR] Erro:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/import-from-agenda/criar-e-confirmar
 * Cria Appointment E já confirma (Session + Payment) em uma chamada só
 */
router.post("/import-from-agenda/criar-e-confirmar", agendaAuth, async (req, res) => {
  try {
    const {
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

    console.log(`[CRIAR-E-CONFIRMAR] Iniciando: ${patientInfo?.fullName}`);

    // 1) Buscar doutor
    const doctor = await findDoctorByName(professionalName);
    if (!doctor) {
      return res.status(400).json({
        success: false,
        code: "DOCTOR_NOT_FOUND",
        error: `Profissional "${professionalName}" não encontrado no CRM`,
      });
    }

    // 2) Verificar duplicata (mesmo slot já scheduled)
    if (date && time) {
      const existing = await Appointment.findOne({
        doctor: doctor._id,
        date,
        time,
        operationalStatus: { $nin: ['canceled', 'pre_agendado'] }
      }).lean();

      if (existing) {
        console.log(`[CRIAR-E-CONFIRMAR] ⚠️ Slot já ocupado: ${date} ${time}`);
        return res.json({
          success: true,
          message: 'Agendamento já existe para este slot',
          appointmentId: existing._id,
          preAgendamentoId: existing._id,
          status: 'already_confirmed'
        });
      }
    }

    // 3) CRIAR APPOINTMENT via bookFixedSlot (cria Patient + Session + Payment + Appointment)
    // 🚨 IMPORTANTE: Nunca usar 'session' como serviceType — ativa modo payment fantasma
    const rawServiceType = crm.serviceType || 'evaluation';
    const normalizedServiceType = rawServiceType === 'session' ? 'individual_session' : rawServiceType;

    const secretaryNotes = [
      responsible && `Responsável: ${responsible}`,
      observations && `Obs: ${observations}`,
      `[CRIADO E CONFIRMADO VIA AGENDA EXTERNA]`
    ].filter(Boolean).join('\n');

    const bookParams = {
      patientInfo: {
        fullName: patientInfo?.fullName,
        birthDate: patientInfo?.birthDate,
        phone: cleanPhone,
        email: patientInfo?.email
      },
      doctorId: doctor._id.toString(),
      specialty: (specialty || doctor?.specialty || 'fonoaudiologia').toLowerCase(),
      date,
      time,
      sessionType: crm.sessionType === 'avaliacao' ? 'avaliacao' : 'sessao',
      serviceType: normalizedServiceType,
      paymentMethod: crm.paymentMethod || 'pix',
      sessionValue: Number(crm.paymentAmount || 0),
      status: 'scheduled',
      notes: secretaryNotes
    };

    const result = await bookFixedSlot(bookParams);

    if (!result.success) {
      throw new Error(result.error || 'Erro ao criar agendamento');
    }

    console.log(`[CRIAR-E-CONFIRMAR] ✅ Sucesso: ${result.appointment._id}`);

    try {
      const io = getIo();
      io.emit("appointmentCreated", result.appointment);
      console.log(`📡 Socket emitido: appointmentCreated ${result.appointment._id}`);
    } catch (socketError) {
      console.error('⚠️ Erro ao emitir socket:', socketError.message);
    }

    return res.status(201).json({
      success: true,
      message: 'Agendamento criado e confirmado!',
      preAgendamentoId: result.appointment._id,
      appointmentId: result.appointment._id,
      patientId: result.patientId
    });

  } catch (err) {
    console.error("[CRIAR-E-CONFIRMAR] error:", err);
    return res.status(500).json({
      success: false,
      code: "INTERNAL_ERROR",
      error: err.message
    });
  }
});

/**
 * POST /api/import-from-agenda/sync-cancel
 * Cancela um agendamento vindo da agenda externa
 * 
 * NOTA: Fonte única de verdade: MongoDB.
 */
router.post("/agenda-externa/cancel", agendaAuth, async (req, res) => {
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
        _id,
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
            details: { reason, confirmedAbsence }
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
router.post("/agenda-externa/update", agendaAuth, async (req, res) => {
  try {
    const {
      _id,
      date,
      time,
      professionalName,
      doctorId: doctorIdRaw,
      patientId: patientIdRaw,
      isNewPatient,
      specialty,
      patientInfo,
      observations,
      status,
      operationalStatus,
      billingType,
      paymentStatus,
      insuranceProvider,
      insuranceValue,
      authorizationCode,
      crm: crmRaw,
      responsible
    } = req.body;

    const crm = crmRaw || {};

    // Buscar doutor: primeiro por doctorId direto, depois por nome
    let doctor = null;
    if (doctorIdRaw) {
      doctor = await Doctor.findById(doctorIdRaw).lean();
    }
    if (!doctor && professionalName) {
      doctor = await findDoctorByName(professionalName);
    }
    
    // 🗺️ MAPEAMENTO DE CAMPOS: formato agenda externa → formato CRM interno
    const mappedData = {
      // IDs
      doctorId: doctor?._id || null,
      patientId: patientInfo?.patientId || null,
      
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
      return res.status(400).json({ success: false, error: "_id é obrigatório" });
    }

    console.log(`[SYNC-UPDATE] Atualizando agendamento: ${_id}`);

    // 1) Buscar Appointment
    const appointment = await Appointment.findById(_id);

    if (!appointment) {
      console.log(`[SYNC-UPDATE] ❌ Appointment não encontrado: ${_id}`);
      return res.status(404).json({ success: false, error: "Agendamento não encontrado", _id });
    }

    console.log(`[SYNC-UPDATE] ✅ Appointment encontrado: ${appointment._id}`);

    // OTIMIZAÇÃO: Se for agendamento antigo (>7 dias) e já concluído, não gasta recursos
    if (['paid', 'confirmed', 'completed'].includes(appointment.operationalStatus) &&
      new Date(appointment.date) < new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)) {
      console.log(`[SYNC-UPDATE] ℹ️ Appointment ${appointment._id} já concluído há mais de 7 dias, ignorando update`);
      return res.json({ success: true, message: "Histórico preservado", status: 'archived' });
    }

    const updateData = { updatedAt: new Date() };
    if (date) updateData.date = date;
    if (time) updateData.time = time;
    if (observations) updateData.notes = observations;
    if (specialty) updateData.specialty = specialty.toLowerCase();
    if (responsible !== undefined) updateData.responsible = responsible;
    if (billingType) updateData.billingType = billingType;
    if (paymentStatus) updateData.paymentStatus = paymentStatus;
    if (insuranceProvider !== undefined) updateData.insuranceProvider = insuranceProvider || null;
    if (insuranceValue !== undefined) updateData.insuranceValue = Number(insuranceValue || 0);
    if (authorizationCode !== undefined) updateData.authorizationCode = authorizationCode || null;

    // Prioridade para operationalStatus (unificado)
    if (operationalStatus) {
      updateData.operationalStatus = operationalStatus;
    } else if (status) {
      const statusMap = { "pendente": "scheduled", "confirmado": "confirmed", "cancelado": "canceled", "pago": "paid", "faltou": "missed" };
      const mapped = statusMap[status.toLowerCase()];
      if (mapped) updateData.operationalStatus = mapped;
    }

    // Adiciona doctor ao updateData se encontrado
    if (doctor) updateData.doctor = doctor._id;
    if (crmRaw?.paymentMethod) updateData.paymentMethod = crmRaw.paymentMethod;
    if (crmRaw?.paymentAmount !== undefined) updateData.sessionValue = Number(crmRaw.paymentAmount || 0);
    if (crmRaw?.serviceType) {
      const APPT_SERVICE_TYPES = ['evaluation','session','package_session','individual_session','meet','alignment','return','tongue_tie_test','neuropsych_evaluation','convenio_session'];
      if (APPT_SERVICE_TYPES.includes(crmRaw.serviceType)) updateData.serviceType = crmRaw.serviceType;
    }

    // ─── PROMOÇÃO pre_agendado → scheduled/confirmed ──────────────────────────
    // Atualiza o appointment existente e cria Session + Payment (mesmo padrão do POST /api/appointments)
    const isPromoting = appointment.operationalStatus === 'pre_agendado' &&
      updateData.operationalStatus && updateData.operationalStatus !== 'pre_agendado' &&
      !appointment.session;

    if (isPromoting) {
      const doctorId = doctor?._id || appointment.doctor || null;

      // Resolver patientId: usa o existente, ou o enviado, ou cria novo se isNewPatient
      let patientId = appointment.patient || null;
      if (!patientId && patientIdRaw && mongoose.Types.ObjectId.isValid(patientIdRaw)) {
        patientId = patientIdRaw;
      }
      if (!patientId && isNewPatient && patientInfo?.fullName) {
        const info = { ...appointment.patientInfo, ...(patientInfo || {}) };
        const created = await Patient.create({
          fullName: info.fullName,
          phone: (info.phone || '').replace(/\D/g, '') || undefined,
          email: info.email || undefined,
          dateOfBirth: info.birthDate || undefined,
          source: 'agenda_externa'
        });
        patientId = created._id;
      }
      if (patientId) updateData.patient = patientId;
      const appointmentDate = date || appointment.date;
      const appointmentTime = time || appointment.time;
      const sessionValue = Number(crm.paymentAmount || appointment.sessionValue || 0);
      const paymentMethod = crm.paymentMethod || appointment.paymentMethod || 'pix';
      // Session.paymentMethod enum: ['dinheiro','pix','cartão','convenio']
      const sessionPaymentMethod = ['dinheiro', 'pix', 'cartão', 'convenio'].includes(paymentMethod)
        ? paymentMethod
        : paymentMethod.startsWith('cartao') ? 'cartão' : null;
      // Payment.serviceType enum não inclui 'return','convenio_session' etc → mapa seguro
      const PAYMENT_SERVICE_TYPES = ['evaluation', 'session', 'package_session', 'tongue_tie_test', 'neuropsych_evaluation', 'individual_session', 'meet', 'alignment'];
      const rawServiceType = crm.serviceType === 'session' ? 'individual_session' : (crm.serviceType || appointment.serviceType || 'evaluation');
      const serviceType = PAYMENT_SERVICE_TYPES.includes(rawServiceType) ? rawServiceType : 'individual_session';
      const sessionType = crm.sessionType || appointment.sessionType || 'avaliacao';
      const resolvedBillingType = billingType || appointment.billingType || 'particular';

      const newSession = await Session.create([{
        patient: patientId,
        doctor: doctorId,
        appointmentId: appointment._id,
        sessionType,
        notes: observations || appointment.notes || '',
        status: 'scheduled',
        isPaid: false,
        paymentStatus: 'pending',
        visualFlag: 'pending',
        date: appointmentDate,
        time: appointmentTime,
        sessionValue,
        ...(sessionPaymentMethod && { paymentMethod: sessionPaymentMethod }),
      }]);

      const paymentData = {
        patient: patientId,
        doctor: doctorId,
        session: newSession[0]._id,
        appointment: appointment._id,
        serviceType,
        amount: sessionValue,
        paymentMethod,
        billingType: resolvedBillingType,
        status: 'pending',
        paymentDate: appointmentDate,
        serviceDate: appointmentDate,
      };
      // Convenio: popula sub-doc insurance
      if (resolvedBillingType === 'convenio') {
        paymentData.insurance = {
          provider: insuranceProvider || appointment.insuranceProvider || '',
          authorizationCode: authorizationCode || appointment.authorizationCode || '',
          status: 'pending_billing',
          grossAmount: Number(insuranceValue || appointment.insuranceValue || 0),
        };
      }
      const newPayment = await Payment.create([paymentData]);

      await Session.findByIdAndUpdate(newSession[0]._id, { paymentId: newPayment[0]._id });

      updateData.session = newSession[0]._id;
      updateData.payment = newPayment[0]._id;
      updateData.sessionValue = sessionValue;
      updateData.paymentMethod = paymentMethod;
      updateData.serviceType = serviceType;

      console.log(`[SYNC-UPDATE] ✅ Session ${newSession[0]._id} + Payment ${newPayment[0]._id} criados para appointment ${appointment._id}`);
    }

    // Para pre_agendado sem promoção: atualiza campos de patientInfo
    if (appointment.operationalStatus === 'pre_agendado' && patientInfo) {
      updateData.patientInfo = { ...appointment.patientInfo, ...patientInfo };
      if (doctor) updateData.professionalName = doctor.fullName;
    }

    // SE FOR APPOINTMENT REAL: atualização completa
    // 2) Atualizar Patient (nome, telefone, etc.)
    if (appointment.patient && patientInfo) {
      const patientUpdate = {};
      if (patientInfo.fullName) {
        // Limpar nome (remover quebras de linha e espaços extras)
        patientUpdate.fullName = patientInfo.fullName.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
      }
      if (patientInfo.phone) {
        // Limpar telefone (apenas números)
        patientUpdate.phone = String(patientInfo.phone).replace(/\D/g, '');
      }
      if (patientInfo.birthDate) patientUpdate.dateOfBirth = patientInfo.birthDate;
      if (patientInfo.email) patientUpdate.email = patientInfo.email;
      patientUpdate.updatedAt = new Date();
      
      if (Object.keys(patientUpdate).length > 0) {
        const updatedPatient = await Patient.findByIdAndUpdate(
          appointment.patient,
          patientUpdate,
          { new: true }
        );
        console.log(`[SYNC-UPDATE] ✅ Patient ${appointment.patient} atualizado:`, {
          name: updatedPatient?.fullName,
          phone: updatedPatient?.phone
        });
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
        }
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
        }
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
            newStatus: updateData.operationalStatus,
            timestamp: new Date(),
            context: `source: agenda_externa | status: ${updateData.operationalStatus || appointment.operationalStatus}`
          }
        }
      },
      { new: true }
    ).populate('patient doctor session payment');
    
    console.log('[SYNC-UPDATE] 📋 updatedAppointment:', {
      _id: updatedAppointment._id,
      date: updatedAppointment.date,
      time: updatedAppointment.time,
      doctor: updatedAppointment.doctor?._id,
      notes: updatedAppointment.notes
    });

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
    console.error("[SYNC-UPDATE] Erro:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
      code: "SYNC_UPDATE_ERROR"
    });
  }
});

/**
 * POST /api/import-from-agenda/sync-delete
 * Exclui (deleta permanentemente) um agendamento vindo da agenda externa
 * 
 * NOTA: Fonte única de verdade: MongoDB.
 */
router.post("/agenda-externa/delete", agendaAuth, async (req, res) => {
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

    await session.commitTransaction();

    // 4) Emitir socket
    try {
      const io = getIo();
      io.emit("appointmentDeleted", {
        appointmentId: appointment._id,
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
 * Confirma um Appointment (muda operationalStatus para 'scheduled')
 */
router.post("/agenda-externa/confirmar-agendamento", agendaAuth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { _id } = req.body;

    if (!_id) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, error: "_id é obrigatório" });
    }

    console.log(`[CONFIRMAR-AGENDAMENTO] Confirmando: ${_id}`);

    const appointment = await Appointment.findById(_id).session(session);

    if (!appointment) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, error: "Agendamento não encontrado", _id });
    }

    // Já confirmado
    if (appointment.operationalStatus === 'scheduled') {
      await session.commitTransaction();
      return res.json({
        success: true,
        message: "Agendamento já estava confirmado",
        appointmentId: appointment._id,
        preAgendamentoId: appointment._id,
        status: 'already_confirmed'
      });
    }

    appointment.operationalStatus = 'scheduled';
    appointment.updatedAt = new Date();

    if (!appointment.history) appointment.history = [];
    appointment.history.push({
      action: 'confirmacao_manual',
      changedBy: null,
      timestamp: new Date(),
      context: 'operacional'
    });

    await appointment.save({ session });

    // Atualizar Session se existir
    if (appointment.session) {
      await Session.findByIdAndUpdate(
        appointment.session,
        { $set: { status: 'scheduled', updatedAt: new Date() } },
        { session }
      );
    }

    await session.commitTransaction();

    console.log(`[CONFIRMAR-AGENDAMENTO] ✅ Appointment ${appointment._id} confirmado`);

    try {
      const io = getIo();
      io.emit("appointmentUpdated", appointment);
      console.log(`📡 Socket emitido: appointmentUpdated ${appointment._id}`);
    } catch (socketError) {
      console.error("⚠️ Erro ao emitir socket:", socketError.message);
    }

    return res.json({
      success: true,
      message: "Agendamento confirmado com sucesso!",
      appointmentId: appointment._id,
      preAgendamentoId: appointment._id,
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

/**
 * ======================================================
 * GET /api/import-from-agenda/weekly-availability
 * 
 * Retorna grade de horários LIVRES da semana para todos os profissionais
 * de uma especialidade específica.
 * 
 * Query params:
 *   - startDate: Data de início (YYYY-MM-DD), idealmente uma segunda
 *   - specialty: Especialidade (fonoaudiologia, psicologia, etc)
 *   - days: Quantidade de dias (default: 7, max: 14)
 * 
 * Exemplo de retorno:
 * {
 *   success: true,
 *   weekStart: "2026-02-24",
 *   weekEnd: "2026-03-02",
 *   specialty: "fonoaudiologia",
 *   days: [
 *     {
 *       date: "2026-02-24",
 *       dayOfWeek: "tuesday",
 *       dayLabel: "Terça-feira",
 *       professionals: [
 *         {
 *           doctorId: "...",
 *           name: "Lorrany",
 *           specialty: "fonoaudiologia",
 *           availableSlots: ["08:00", "09:00", "14:00", "15:00"]
 *         }
 *       ]
 *     }
 *   ]
 * }
 * ======================================================
 */
router.get("/agenda-externa/disponibilidade", agendaAuth, async (req, res) => {
  try {
    const { startDate, specialty, days = 7 } = req.query;

    // Validações
    if (!startDate || !specialty) {
      return res.status(400).json({
        success: false,
        error: "startDate e specialty são obrigatórios"
      });
    }

    const daysCount = Math.min(parseInt(days) || 7, 14);

    // 1. Buscar profissionais ativos da especialidade (1 query)
    const doctors = await Doctor.find({
      specialty: specialty.toLowerCase(),
      active: true
    }).lean();

    if (!doctors.length) {
      return res.status(404).json({
        success: false,
        error: `Nenhum profissional encontrado para: ${specialty}`
      });
    }

    // 2. Gerar datas da semana
    const DAYS_PT = {
      sunday: "Dom", monday: "Seg", tuesday: "Ter", wednesday: "Qua",
      thursday: "Qui", friday: "Sex", saturday: "Sáb"
    };
    const DAYS_EN = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

    const weekDays = [];
    const start = new Date(`${startDate}T12:00:00-03:00`);
    
    for (let i = 0; i < daysCount; i++) {
      const currentDate = new Date(start);
      currentDate.setDate(start.getDate() + i);
      const dateStr = currentDate.toISOString().split('T')[0];
      const dayOfWeek = DAYS_EN[currentDate.getDay()];
      weekDays.push({ date: dateStr, dayOfWeek, dayLabel: DAYS_PT[dayOfWeek] });
    }

    const dates = weekDays.map(d => d.date);
    const doctorIds = doctors.map(d => d._id);

    // 3. Buscar TODOS os agendamentos da semana de uma vez (1 query)
    const appointments = await Appointment.find({
      date: { $in: dates },
      doctor: { $in: doctorIds },
      operationalStatus: { $nin: ['canceled', 'cancelado', 'cancelada', 'no_show', 'missed'] }
    }).select('doctor date time').lean();

    // 4. Indexar agendamentos por doutor e data para acesso rápido
    // pre_agendados também ocupam slot visualmente (já incluídos na query acima)
    const bookedMap = {}; // { doctorId: { date: Set([times]) } }
    appointments.forEach(appt => {
      const docId = String(appt.doctor);
      if (!bookedMap[docId]) bookedMap[docId] = {};
      if (!bookedMap[docId][appt.date]) bookedMap[docId][appt.date] = new Set();
      bookedMap[docId][appt.date].add(String(appt.time).slice(0, 5));
    });

    // 5. Calcular disponibilidade para cada dia
    const result = [];

    for (const day of weekDays) {
      const dayResult = {
        date: day.date,
        dayOfWeek: day.dayOfWeek,
        dayLabel: day.dayLabel,
        professionals: []
      };

      for (const doctor of doctors) {
        // Verificar se tem disponibilidade cadastrada para este dia
        const dailyAvailability = doctor.weeklyAvailability?.find(a => a.day === day.dayOfWeek);
        if (!dailyAvailability?.times?.length) continue;

        // Normalizar horários
        const allSlots = dailyAvailability.times
          .map(t => String(t).slice(0, 5))
          .filter(t => /^\d{2}:\d{2}$/.test(t))
          .sort();

        // Remover ocupados
        const bookedSlots = bookedMap[String(doctor._id)]?.[day.date] || new Set();
        const availableSlots = allSlots.filter(slot => !bookedSlots.has(slot));

        if (availableSlots.length > 0) {
          dayResult.professionals.push({
            doctorId: String(doctor._id),
            name: doctor.fullName,
            specialty: doctor.specialty,
            availableSlots,
            totalSlots: allSlots.length,
            bookedSlots: allSlots.length - availableSlots.length
          });
        }
      }

      if (dayResult.professionals.length > 0) {
        dayResult.professionals.sort((a, b) => a.name.localeCompare(b.name));
        result.push(dayResult);
      }
    }

    return res.json({
      success: true,
      weekStart: startDate,
      weekEnd: weekDays[weekDays.length - 1]?.date,
      specialty: specialty.toLowerCase(),
      totalProfessionals: doctors.length,
      daysWithAvailability: result.length,
      days: result
    });

  } catch (error) {
    console.error("[WEEKLY-AVAILABILITY] Erro:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
      code: "WEEKLY_AVAILABILITY_ERROR"
    });
  }
});

/**
 * GET /api/import-from-agenda/diagnostico/:patientName
 * Diagnóstico de agendamentos duplicados
 */
router.get("/import-from-agenda/diagnostico/:patientName", async (req, res) => {
  try {
    const { patientName } = req.params;
    const searchRegex = new RegExp(patientName, 'i');

    // Buscar appointments (incluindo pre_agendados)
    const appointments = await Appointment.find({
      $or: [
        { patientName: searchRegex },
        { 'patient.fullName': searchRegex },
        { 'patientInfo.fullName': searchRegex }
      ]
    }).populate('patient doctor session payment').lean();

    // Analisar resultados
    const analysis = {
      totalAppointments: appointments.length,
      appointments: appointments.map(a => ({
        id: a._id,
        date: a.date,
        time: a.time,
        status: a.operationalStatus,
        patientName: a.patientName || a.patient?.fullName || a.patientInfo?.fullName,
        hasPayment: !!a.payment,
        hasSession: !!a.session
      }))
    };

    res.json({ success: true, data: analysis });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/import-from-agenda/limpar-henre
 * Deleta pré-agendamentos duplicados do Henre, mantém só o mais recente
 */
router.post("/import-from-agenda/limpar-henre", async (req, res) => {
  try {
    const preAgendamentos = await Appointment.find({
      'patientInfo.fullName': { $regex: /Henre/i },
      operationalStatus: 'pre_agendado'
    }).sort({ createdAt: -1 });

    if (preAgendamentos.length === 0) {
      return res.json({ success: false, message: 'Nenhum pré-agendamento do Henre encontrado' });
    }

    const manter = preAgendamentos[0];
    const deletar = preAgendamentos.slice(1);

    for (const pre of deletar) {
      await Appointment.findByIdAndDelete(pre._id);
      console.log(`[LIMPAR-HENRE] DELETADO: ${pre._id}`);
    }

    res.json({
      success: true,
      message: `Pronto! Mantido: ${manter._id}, Deletados: ${deletar.length}`,
      mantido: { id: manter._id, nome: manter.patientInfo?.fullName, data: manter.date, hora: manter.time },
      deletados: deletar.map(p => p._id)
    });

  } catch (error) {
    console.error('[LIMPAR-HENRE] Erro:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


/**
 * POST /api/import-from-agenda/limpar-duplicados-paciente
 * Remove pré-agendamentos duplicados quando já existe appointment para o paciente
 */
router.post("/import-from-agenda/limpar-duplicados-paciente", async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { patientName, date } = req.body;
    
    // 1. Buscar appointments para esse paciente na data
    const appointments = await Appointment.find({
      patientName: { $regex: patientName, $options: 'i' },
      date: date
    }).session(session);

    // 2. Buscar pre_agendados duplicados para o mesmo paciente na mesma data
    const preAgendadosDuplicados = await Appointment.find({
      'patientInfo.fullName': { $regex: patientName, $options: 'i' },
      date,
      operationalStatus: 'pre_agendado'
    }).session(session);

    if (appointments.length === 0) {
      await session.abortTransaction();
      return res.json({ success: false, message: 'Nenhum appointment encontrado para este paciente nesta data' });
    }

    if (preAgendadosDuplicados.length === 0) {
      await session.abortTransaction();
      return res.json({ success: false, message: 'Nenhum pré-agendamento para limpar' });
    }

    // 3. Marcar pre_agendados como cancelados (descartados)
    const deletados = [];
    for (const pre of preAgendadosDuplicados) {
      pre.operationalStatus = 'canceled';
      pre.discardReason = 'Duplicado - já existe appointment confirmado para este paciente';
      pre.discardedAt = new Date();
      await pre.save({ session });
      deletados.push(pre._id);
    }

    await session.commitTransaction();

    res.json({
      success: true,
      message: `Limpo! ${deletados.length} pré-agendamento(s) cancelado(s)`,
      appointmentsEncontrados: appointments.map(a => ({ id: a._id, date: a.date, time: a.time })),
      preAgendamentosRemovidos: deletados
    });

  } catch (error) {
    await session.abortTransaction();
    res.status(500).json({ success: false, error: error.message });
  } finally {
    session.endSession();
  }
});


/**
 * GET /api/import-from-agenda/auditar-unimed
 * Consulta pacientes Unimed Anápolis e seus agendamentos
 */
router.get("/import-from-agenda/auditar-unimed", async (req, res) => {
  try {
    const db = mongoose.connection.db;

    // Buscar pacientes que tenham Unimed Anápolis
    const pacientes = await db.collection('patients').find({
      $or: [
        { healthPlan: { $regex: /Unimed/i } },
        { insuranceProvider: { $regex: /Unimed/i } },
        { 'insurance.name': { $regex: /Unimed/i } },
        { convenio: { $regex: /Unimed/i } }
      ]
    }).toArray();

    // Se não encontrou por esses campos, buscar por nome
    let pacientesPorNome = [];
    if (pacientes.length === 0) {
      pacientesPorNome = await db.collection('patients').find({
        fullName: { $regex: /Unimed|Anápolis/i, $options: 'i' }
      }).toArray();
    }

    // Buscar appointments com billingType = insurance ou convenio
    const appointments = await db.collection('appointments').find({
      $or: [
        { billingType: 'insurance' },
        { billingType: 'convenio' },
        { insuranceProvider: { $regex: /Unimed|unimed/i } },
        { 'insurance.name': { $regex: /Unimed|unimed/i } }
      ]
    }).sort({ date: -1 }).limit(20).toArray();

    // Buscar pagamentos de convênio
    const payments = await db.collection('payments').find({
      $or: [
        { billingType: 'insurance' },
        { billingType: 'convenio' },
        { 'insurance.name': { $regex: /Unimed|unimed/i } }
      ]
    }).sort({ createdAt: -1 }).limit(10).toArray();

    res.json({
      success: true,
      resumo: {
        pacientesUnimed: pacientes.length,
        pacientesPorNome: pacientesPorNome.length,
        appointmentsConvenio: appointments.length,
        paymentsConvenio: payments.length
      },
      pacientes: pacientes.map(p => ({
        _id: p._id.toString(),
        nome: p.fullName,
        telefone: p.phone,
        convenio: p.healthPlan || p.insuranceProvider || p.convenio
      })),
      appointments: appointments.map(a => ({
        _id: a._id.toString(),
        paciente: a.patientName,
        data: a.date,
        hora: a.time,
        billingType: a.billingType,
        insuranceProvider: a.insuranceProvider,
        status: a.operationalStatus,
        metadata: a.metadata
      })),
      payments: payments.map(p => ({
        _id: p._id.toString(),
        paciente: p.patientName || p.patient?.fullName,
        valor: p.amount,
        billingType: p.billingType,
        insurance: p.insurance?.name
      }))
    });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;