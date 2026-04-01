// back/routes/Payment.js - PATCHED WITH EVENTS
/**
 * Rotas de Pagamento - COM EVENTOS
 * 
 * Toda operação de write em Payment emite evento para atualizar PatientsView
 */

import express from 'express';
import mongoose from 'mongoose';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import Patient from '../models/Patient.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import { auth } from '../middleware/auth.js';

const router = express.Router();

// ============================================
// HELPER: Emissão de eventos de pagamento
// ============================================

/**
 * Emite evento de pagamento recebido
 */
async function emitPaymentEvent(eventType, payment, additionalData = {}) {
  try {
    await publishEvent(eventType, {
      paymentId: payment._id?.toString(),
      patientId: payment.patient?.toString() || payment.patient,
      appointmentId: payment.appointment?.toString() || payment.appointment,
      sessionId: payment.session?.toString() || payment.session,
      amount: payment.amount,
      paymentMethod: payment.paymentMethod,
      status: payment.status,
      isAdvance: payment.isAdvance,
      receivedAt: payment.paidAt?.toISOString() || payment.createdAt?.toISOString() || new Date().toISOString(),
      ...additionalData
    });
  } catch (error) {
    console.error('[PaymentRoutes] Falha ao emitir evento:', error.message);
    // Não throw - não queremos quebrar a operação
  }
}

/**
 * Emite evento de appointment atualizado
 */
async function emitAppointmentEvent(eventType, appointmentId, additionalData = {}) {
  try {
    const appointment = await Appointment.findById(appointmentId).lean();
    if (!appointment) return;
    
    await publishEvent(eventType, {
      appointmentId: appointment._id.toString(),
      patientId: appointment.patient?.toString(),
      doctorId: appointment.doctor?.toString(),
      date: appointment.date,
      time: appointment.time,
      serviceType: appointment.serviceType,
      status: appointment.operationalStatus,
      ...additionalData
    });
  } catch (error) {
    console.error('[PaymentRoutes] Falha ao emitir evento de appointment:', error.message);
  }
}

// ============================================
// ROTAS COM EVENTOS
// ============================================

/**
 * POST /api/payments - Criar pagamento
 * EVENTOS: PAYMENT_RECEIVED, APPOINTMENT_UPDATED (se vinculado)
 */
router.post('/', auth, async (req, res) => {
  try {
    const { 
      patientId, 
      appointmentId, 
      sessionId,
      amount, 
      paymentMethod, 
      status,
      serviceType,
      individualSessionId,
      packageId,
      notes,
      advanceSessions = []
    } = req.body;

    const currentDate = new Date();

    // Validações...
    if (!patientId || !amount || !paymentMethod) {
      return res.status(400).json({
        success: false,
        message: 'patientId, amount e paymentMethod são obrigatórios'
      });
    }

    const paymentData = {
      patient: patientId,
      doctor: req.body.doctorId,
      amount,
      paymentMethod,
      status: status || 'paid',
      notes,
      paidAt: currentDate,
      createdAt: currentDate
    };

    if (appointmentId) paymentData.appointment = appointmentId;
    if (sessionId) paymentData.session = sessionId;
    if (serviceType === 'individual_session' && individualSessionId) {
      paymentData.session = individualSessionId;
    }
    if (serviceType === 'package_session' && packageId) {
      paymentData.package = packageId;
    }

    // 🆕 CRIA PAGAMENTO
    const payment = await Payment.create(paymentData);

    // 🆕 EMITE EVENTO DE PAGAMENTO
    await emitPaymentEvent('PAYMENT_RECEIVED', payment, {
      source: 'payment_routes_create',
      hasAppointment: !!appointmentId,
      hasSession: !!sessionId
    });

    // Atualiza status da sessão
    if (serviceType === 'session' || serviceType === 'individual_session') {
      const sessionToUpdate = serviceType === 'individual_session' ? individualSessionId : sessionId;
      await Session.findByIdAndUpdate(
        sessionToUpdate,
        {
          status: status || 'paid',
          updatedAt: currentDate
        }
      );
    }

    // 🆕 SE TEM APPOINTMENT, EMITE EVENTO DE ATUALIZAÇÃO
    if (appointmentId) {
      await emitAppointmentEvent('APPOINTMENT_UPDATED', appointmentId, {
        paymentId: payment._id.toString(),
        paymentStatus: status || 'paid',
        updatedAt: currentDate.toISOString()
      });
    }

    return res.status(201).json({
      success: true,
      data: payment,
      message: advanceSessions.length > 0
        ? `Pagamento registrado com ${advanceSessions.length} sessões futuras`
        : 'Pagamento registrado com sucesso',
      timestamp: currentDate
    });

  } catch (error) {
    console.error('Erro ao criar pagamento:', error);
    return res.status(500).json({
      success: false,
      message: 'Erro ao registrar pagamento',
      error: error.message
    });
  }
});

/**
 * POST /api/payments/advance - Pagamento adiantado
 * EVENTOS: PAYMENT_RECEIVED (para cada sessão futura)
 */
router.post('/advance', auth, async (req, res) => {
  try {
    const { 
      patientId, 
      doctorId, 
      amount, 
      paymentMethod, 
      notes, 
      status,
      advanceSessions = [] 
    } = req.body;

    // Cria sessões futuras
    const advanceSessionsIds = [];
    for (const session of advanceSessions) {
      const newSession = await Session.create({
        patient: patientId,
        doctor: doctorId,
        date: session.date,
        time: session.time,
        status: 'scheduled',
        isPaid: true,
        paymentMethod: paymentMethod,
        isAdvance: true
      });
      advanceSessionsIds.push(newSession._id);
    }

    // 🆕 CRIA PAGAMENTO
    const payment = await Payment.create({
      patient: patientId,
      doctor: doctorId,
      amount,
      paymentMethod,
      notes,
      status: status || 'paid',
      isAdvance: true,
      advanceSessions: advanceSessionsIds.map(id => ({
        sessionId: id,
        used: false,
        scheduledDate: advanceSessions.find(s => s.sessionId === id.toString())?.date
      })),
      paidAt: new Date()
    });

    // 🆕 EMITE EVENTO DE PAGAMENTO
    await emitPaymentEvent('PAYMENT_RECEIVED', payment, {
      source: 'payment_routes_advance',
      isAdvance: true,
      sessionsCount: advanceSessionsIds.length
    });

    // 🆕 EMITE EVENTOS PARA CADA SESSÃO CRIADA
    for (const sessionId of advanceSessionsIds) {
      await publishEvent('SESSION_CREATED', {
        sessionId: sessionId.toString(),
        patientId,
        doctorId,
        isAdvance: true,
        paymentId: payment._id.toString()
      });
    }

    return res.status(201).json({
      success: true,
      data: payment,
      message: `Pagamento adiantado registrado com ${advanceSessionsIds.length} sessões`
    });

  } catch (error) {
    console.error('Erro no pagamento adiantado:', error);
    return res.status(500).json({
      success: false,
      message: 'Erro ao registrar pagamento adiantado',
      error: error.message
    });
  }
});

/**
 * PUT /api/payments/:id - Atualizar pagamento
 * EVENTOS: PAYMENT_UPDATED, APPOINTMENT_UPDATED (se status mudar)
 */
router.put('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;
    
    // Busca pagamento antigo para comparar
    const oldPayment = await Payment.findById(id).lean();
    if (!oldPayment) {
      return res.status(404).json({
        success: false,
        message: 'Pagamento não encontrado'
      });
    }

    // 🆕 ATUALIZA PAGAMENTO
    const payment = await Payment.findByIdAndUpdate(
      id,
      { ...updateData, updatedAt: new Date() },
      { new: true }
    );

    // 🆕 EMITE EVENTO DE ATUALIZAÇÃO
    await emitPaymentEvent('PAYMENT_UPDATED', payment, {
      source: 'payment_routes_update',
      previousStatus: oldPayment.status,
      newStatus: payment.status,
      updatedFields: Object.keys(updateData)
    });

    // 🆕 SE STATUS MUDOU PARA PAID, EMITE PAYMENT_RECEIVED
    if (oldPayment.status !== 'paid' && payment.status === 'paid') {
      await emitPaymentEvent('PAYMENT_RECEIVED', payment, {
        source: 'payment_routes_update_to_paid'
      });
    }

    // 🆕 SE TEM APPOINTMENT E STATUS MUDOU
    if (payment.appointment && oldPayment.status !== payment.status) {
      await emitAppointmentEvent('APPOINTMENT_UPDATED', payment.appointment, {
        paymentId: payment._id.toString(),
        paymentStatus: payment.status,
        updatedAt: new Date().toISOString()
      });
    }

    return res.status(200).json({
      success: true,
      data: payment,
      message: 'Pagamento atualizado com sucesso'
    });

  } catch (error) {
    console.error('Erro ao atualizar pagamento:', error);
    return res.status(500).json({
      success: false,
      message: 'Erro ao atualizar pagamento',
      error: error.message
    });
  }
});

/**
 * DELETE /api/payments/:id - Deletar pagamento
 * EVENTOS: PAYMENT_DELETED, APPOINTMENT_UPDATED (se vinculado)
 */
router.delete('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    
    const payment = await Payment.findById(id).lean();
    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Pagamento não encontrado'
      });
    }

    const appointmentId = payment.appointment;
    const patientId = payment.patient;

    // 🆕 EMITE EVENTO ANTES DE DELETAR
    await publishEvent('PAYMENT_DELETED', {
      paymentId: id,
      patientId: patientId?.toString(),
      appointmentId: appointmentId?.toString(),
      amount: payment.amount,
      deletedAt: new Date().toISOString()
    });

    // 🆕 SE TEM APPOINTMENT, ATUALIZA
    if (appointmentId) {
      await emitAppointmentEvent('APPOINTMENT_UPDATED', appointmentId, {
        paymentId: id,
        paymentStatus: 'deleted',
        updatedAt: new Date().toISOString()
      });
    }

    // Deleta
    await Payment.findByIdAndDelete(id);

    return res.status(200).json({
      success: true,
      message: 'Pagamento removido com sucesso'
    });

  } catch (error) {
    console.error('Erro ao deletar pagamento:', error);
    return res.status(500).json({
      success: false,
      message: 'Erro ao remover pagamento',
      error: error.message
    });
  }
});

/**
 * POST /api/payments/multi - Pagamento múltiplo
 * EVENTOS: PAYMENT_RECEIVED para cada pagamento
 */
router.post('/multi', auth, async (req, res) => {
  try {
    const { payments } = req.body;
    const createdPayments = [];

    for (const paymentData of payments) {
      // 🆕 CRIA PAGAMENTO
      const payment = await Payment.create({
        ...paymentData,
        createdAt: new Date(),
        paidAt: new Date()
      });

      createdPayments.push(payment);

      // 🆕 EMITE EVENTO
      await emitPaymentEvent('PAYMENT_RECEIVED', payment, {
        source: 'payment_routes_multi'
      });

      // 🆕 SE TEM APPOINTMENT
      if (payment.appointment) {
        await emitAppointmentEvent('APPOINTMENT_UPDATED', payment.appointment, {
          paymentId: payment._id.toString(),
          paymentStatus: payment.status
        });
      }
    }

    return res.status(201).json({
      success: true,
      data: createdPayments,
      count: createdPayments.length,
      message: `${createdPayments.length} pagamentos registrados`
    });

  } catch (error) {
    console.error('Erro no pagamento múltiplo:', error);
    return res.status(500).json({
      success: false,
      message: 'Erro ao registrar pagamentos',
      error: error.message
    });
  }
});

export default router;
