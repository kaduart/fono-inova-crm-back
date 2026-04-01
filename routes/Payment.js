// back/routes/Payment.js - PATCHED WITH EVENTS
/**
 * Rotas de Pagamento - COM EVENTOS
 * 
 * Toda operação de write em Payment emite evento para atualizar PatientsView
 */

import express from 'express';
import mongoose from 'mongoose';
import moment from 'moment-timezone';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import Patient from '../models/Patient.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import { auth } from '../middleware/auth.js';
import { mapStatusToClinical, mapStatusToOperational } from '../utils/statusMappers.js';

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

// ======================================================
// 📅 ROTA: FECHAMENTO DIÁRIO (legado)
// ======================================================
router.get("/daily-closing", auth, async (req, res) => {
    try {
        const { date } = req.query;

        const targetDate = date
            ? moment.tz(date, "America/Sao_Paulo").format("YYYY-MM-DD")
            : moment.tz(new Date(), "America/Sao_Paulo").format("YYYY-MM-DD");

        const startOfDay = moment.tz(`${targetDate}T00:00:00`, "America/Sao_Paulo").toDate();
        const endOfDay = moment.tz(`${targetDate}T23:59:59`, "America/Sao_Paulo").toDate();

        const sessions = await Session.find({ date: targetDate })
            .populate("package patient doctor appointmentId")
            .lean();

        if (sessions.length > 0) {
            const bulkOps = sessions.filter(s => s.appointmentId).map(s => {
                const paidLike = ['paid', 'package_paid', 'advanced', 'partial']
                    .includes(String(s.paymentStatus || '').toLowerCase()) || !!s.isPaid;
                return {
                    updateOne: {
                        filter: { _id: s.appointmentId },
                        update: { $set: {
                            sessionValue: s.sessionValue,
                            paymentStatus: paidLike ? (s.paymentStatus || 'paid') : (s.paymentStatus || 'pending'),
                            operationalStatus: mapStatusToOperational(s.status),
                            clinicalStatus: mapStatusToClinical(s.status),
                        }}
                    }
                };
            });
            if (bulkOps.length > 0) {
                Appointment.bulkWrite(bulkOps, { ordered: false })
                    .catch(e => console.error('[daily-closing] bulkWrite error:', e.message));
            }
        }

        const [appointmentsCreated, appointmentsToday, payments] = await Promise.all([
            Appointment.find({ createdAt: { $gte: startOfDay, $lte: endOfDay }, serviceType: { $ne: 'package_session' } })
                .populate("doctor patient package").lean(),
            Appointment.find({ $or: [{ date: { $gte: startOfDay, $lte: endOfDay } }, { createdAt: { $gte: startOfDay, $lte: endOfDay } }] })
                .populate("doctor patient package").lean(),
            Payment.find({
                status: { $in: ["paid", "package_paid"] },
                $or: [
                    { paymentDate: { $gte: startOfDay, $lte: endOfDay } },
                    { paymentDate: targetDate },
                    { paymentDate: { $exists: false }, createdAt: { $gte: startOfDay, $lte: endOfDay } },
                ],
            }).populate("patient doctor package appointment").lean()
        ]);

        const uniqueAppointmentsMap = new Map();
        for (const appt of appointmentsToday) {
            const id = appt._id.toString();
            if (!uniqueAppointmentsMap.has(id)) uniqueAppointmentsMap.set(id, appt);
        }
        const uniqueAppointmentsToday = Array.from(uniqueAppointmentsMap.values());

        const getPaymentDate = (pay) => {
            if (!pay) return null;
            if (typeof pay.paymentDate === "string" && pay.paymentDate.trim()) return pay.paymentDate;
            return moment(pay.createdAt).tz("America/Sao_Paulo").format("YYYY-MM-DD");
        };
        const normalizePaymentMethod = (method) => {
            if (!method) return "dinheiro";
            method = String(method).toLowerCase().trim();
            if (method.includes("pix")) return "pix";
            if (method.includes("cartão") || method.includes("cartao") || method.includes("card") ||
                method.includes("credito") || method.includes("débito") || method.includes("debito")) return "cartão";
            return "dinheiro";
        };
        const isCanceled = (s) => ["canceled"].includes((s || "").toLowerCase());
        const isConfirmed = (s) => ["confirmed"].includes((s || "").toLowerCase());
        const isCompleted = (s) => ["completed"].includes((s || "").toLowerCase());

        const filteredPayments = payments.filter((p) => {
            const payDate = getPaymentDate(p);
            if (p.billingType === 'convenio') {
                return p.insurance?.status === 'received' &&
                    p.insurance?.receivedAt &&
                    moment(p.insurance.receivedAt).format('YYYY-MM-DD') === targetDate;
            }
            return payDate === targetDate;
        });

        const packageIdsToday = [...new Set(
            uniqueAppointmentsToday.filter(a => a.serviceType === 'package_session' && a.package?._id)
                .map(a => a.package._id.toString())
        )];

        const historicalPackagePayments = packageIdsToday.length > 0
            ? await Payment.find({
                package: { $in: packageIdsToday.map(id => new mongoose.Types.ObjectId(id)) },
                status: { $in: ['paid', 'package_paid'] }
            }).populate('patient doctor package appointment').lean()
            : [];

        const allPaymentsForMaps = [...payments,
            ...historicalPackagePayments.filter(hp => !payments.some(p => p._id.toString() === hp._id.toString()))
        ];

        const paymentsByAppt = new Map();
        const paymentsByPackage = new Map();
        const paymentsByPatient = new Map();
        allPaymentsForMaps.forEach(p => {
            const apptId = p.appointment?._id?.toString();
            if (apptId) { if (!paymentsByAppt.has(apptId)) paymentsByAppt.set(apptId, []); paymentsByAppt.get(apptId).push(p); }
            const pkgId = p.package?._id?.toString();
            if (pkgId) { if (!paymentsByPackage.has(pkgId)) paymentsByPackage.set(pkgId, []); paymentsByPackage.get(pkgId).push(p); }
            const patId = p.patient?._id?.toString();
            if (patId) { if (!paymentsByPatient.has(patId)) paymentsByPatient.set(patId, []); paymentsByPatient.get(patId).push(p); }
        });

        const report = {
            date: targetDate,
            summary: {
                appointments: { total: 0, attended: 0, canceled: 0, pending: 0, expectedValue: 0, pendingValue: 0, pendingCount: 0 },
                payments: { totalReceived: 0, byMethod: { dinheiro: 0, pix: 0, cartão: 0 } },
                insurance: { production: 0, sessionsCount: 0, received: 0, pending: 0, byProvider: [] },
            },
            financial: {
                totalReceived: 0, totalExpected: 0, totalRevenue: 0,
                totalInsuranceProduction: 0, totalInsurancePending: 0, grandTotal: 0,
                paymentMethods: {
                    dinheiro: { amount: 0, details: [] },
                    pix: { amount: 0, details: [] },
                    cartão: { amount: 0, details: [] },
                },
                packages: { total: 0, details: [] },
                insurance: { total: 0, byProvider: [] },
            },
            timelines: { appointments: [], payments: [], insuranceSessions: [] },
            professionals: [],
            timeSlots: [],
        };

        for (const appt of uniqueAppointmentsToday) {
            const opStatus = (appt.operationalStatus || "").toLowerCase();
            const clinicalStatus = (appt.clinicalStatus || "").toLowerCase();
            const doctorName = appt.doctor?.fullName || "Não informado";
            const patientName = appt.patient?.fullName || appt.patientInfo?.fullName || "Não informado";
            const isPackage = appt.serviceType === "package_session";
            const isLiminar = isPackage && appt.package?.type === 'liminar';
            const apptId = appt._id.toString();
            const pkgId = appt.package?._id?.toString();
            const patId = appt.patient?._id?.toString();
            const allRelatedPays = [
                ...(paymentsByAppt.get(apptId) || []),
                ...(pkgId ? (paymentsByPackage.get(pkgId) || []) : []),
                ...(patId ? (paymentsByPatient.get(patId) || []) : [])
            ];
            const uniquePays = [...new Map(allRelatedPays.map(p => [p._id.toString(), p])).values()];
            const relatedPayToday = uniquePays.find((p) => getPaymentDate(p) === targetDate);
            const relatedPayAnyDay = uniquePays.find((p) => getPaymentDate(p) !== null);
            const method = relatedPayToday
                ? normalizePaymentMethod(relatedPayToday.paymentMethod)
                : normalizePaymentMethod(appt.package?.paymentMethod || appt.paymentMethod || "—");
            const paidStatus = relatedPayToday ? "Pago no dia" : (relatedPayAnyDay ? "Pago antes" : "Pendente");
            const sessionValue = Number(appt.sessionValue || 0);
            report.summary.appointments.total++;
            if (isCanceled(opStatus)) report.summary.appointments.canceled++;
            else if (isConfirmed(opStatus) || isCompleted(clinicalStatus)) report.summary.appointments.attended++;
            else report.summary.appointments.pending++;
            report.summary.appointments.expectedValue += sessionValue;
            const isConvenioAppt = appt.serviceType === 'convenio_session' || appt.paymentMethod === 'convenio' ||
                appt.insuranceProvider || appt.package?.type === 'convenio';
            const insuranceValue = isConvenioAppt ? (appt.package?.insuranceGrossAmount || appt.insuranceValue || 80) : 0;
            report.timelines.appointments.push({
                id: apptId, patient: patientName, phone: appt.patient?.phone || null,
                patientType: appt.patientType || null, service: appt.serviceType, doctor: doctorName,
                sessionValue, method, paidStatus, operationalStatus: opStatus, clinicalStatus,
                displayStatus: paidStatus, date: appt.date, time: appt.time, isPackage, isLiminar,
                paymentMethod: method, packageId: pkgId || null,
                isConvenio: isConvenioAppt,
                insuranceProvider: isConvenioAppt ? (appt.insuranceProvider || appt.package?.insuranceProvider) : null,
                insuranceValue: isConvenioAppt ? insuranceValue : null,
                isFirstAppointment: appt.isFirstAppointment || false,
            });
        }

        const insuranceSessions = sessions.filter(s => s.package?.type === 'convenio' || s.paymentMethod === 'convenio' || s.billingType === 'convenio');
        const insuranceByProvider = {};
        for (const session of insuranceSessions) {
            const pkg = session.package;
            const provider = pkg?.insuranceProvider || session.insuranceProvider || 'Convênio';
            const insValue = pkg?.insuranceGrossAmount || pkg?.sessionValue || 80;
            const done = session.status === 'completed';
            report.timelines.insuranceSessions.push({
                id: session._id.toString(), time: session.time,
                patient: session.patient?.fullName || 'N/A', provider, insuranceValue: insValue,
                status: session.status, paymentStatus: session.paymentStatus || 'pending_receipt',
                isPaid: session.isPaid || false, guideNumber: session.insuranceGuide?.number || null,
            });
            if (done) {
                report.summary.insurance.production += insValue;
                report.summary.insurance.sessionsCount += 1;
                if (session.isPaid) report.summary.insurance.received += insValue;
                else report.summary.insurance.pending += insValue;
                if (!insuranceByProvider[provider]) insuranceByProvider[provider] = { value: 0, sessions: 0 };
                insuranceByProvider[provider].value += insValue;
                insuranceByProvider[provider].sessions += 1;
            }
        }
        report.summary.insurance.byProvider = Object.entries(insuranceByProvider).map(([provider, data]) => ({ provider, ...data }));
        report.financial.totalInsuranceProduction = report.summary.insurance.production;
        report.financial.totalInsurancePending = report.summary.insurance.pending;
        report.financial.insurance = { total: report.summary.insurance.production, byProvider: report.summary.insurance.byProvider };

        for (const pay of filteredPayments) {
            const paymentDate = getPaymentDate(pay);
            if (paymentDate !== targetDate) continue;
            const amount = Number(pay.amount || 0);
            const method = normalizePaymentMethod(pay.paymentMethod);
            const type = pay.serviceType || "outro";
            const patient = pay.patient?.fullName || "Avulso";
            const doctor = pay.doctor?.fullName || "Não vinculado";
            report.summary.payments.totalReceived += amount;
            report.summary.payments.byMethod[method] += amount;
            report.financial.totalReceived += amount;
            report.financial.paymentMethods[method].amount += amount;
            report.financial.paymentMethods[method].details.push({
                id: pay._id.toString(), type, patient, value: amount, method,
                createdAt: pay.createdAt, doctor, status: pay.status, paymentDate,
                referenceDate: pay.appointment?.date || null,
                isAdvancePayment: pay.isAdvance || false,
                appointmentId: pay.appointment?._id?.toString() || null,
            });
            if (type === "package_session" && pay.package) {
                report.financial.packages.total += amount;
                report.financial.packages.details.push({
                    id: pay._id.toString(), patient, value: amount, method,
                    sessions: pay.package?.totalSessions || 0, sessionValue: pay.package?.sessionValue || 0,
                    date: paymentDate, packageId: pay.package._id.toString(),
                });
            }
            report.timelines.payments.push({ id: pay._id.toString(), patient, type, method, value: amount, paymentDate, doctor, serviceType: pay.serviceType || null });
        }

        const timelineAppointments = report.timelines.appointments || [];
        const validAppointments = timelineAppointments.filter(a => !isCanceled(a.operationalStatus));
        report.financial.totalExpected = timelineAppointments.reduce((sum, a) => sum + (a.sessionValue || 0), 0);
        report.financial.totalRevenue = validAppointments.filter(a => a.paidStatus === "Pendente" && isConfirmed(a.operationalStatus) && !a.isConvenio).reduce((sum, a) => sum + (a.sessionValue || 0), 0);
        report.summary.appointments.pendingCount = validAppointments.filter(a => a.paidStatus === "Pendente" && isConfirmed(a.operationalStatus) && !a.isConvenio).length;
        report.summary.appointments.expectedValue = timelineAppointments.reduce((sum, a) => sum + (a.sessionValue || 0), 0);
        report.summary.appointments.totalDoDia = uniqueAppointmentsToday.length;
        report.summary.appointments.confirmadosDoDia = uniqueAppointmentsToday.filter(a => !isCanceled(a.operationalStatus) && (isConfirmed(a.operationalStatus) || isCompleted(a.clinicalStatus))).length;
        const isNovo = (a) => a.patientType === 'novo' || a.isFirstAppointment === true;
        const isRecorrente = (a) => a.patientType === 'recorrente' || a.patientType === 'retorno' || a.isFirstAppointment === false;
        report.summary.appointments.novos = uniqueAppointmentsToday.filter(isNovo).length;
        report.summary.appointments.recorrentes = uniqueAppointmentsToday.filter(isRecorrente).length;
        report.appointmentsByType = {
            novos: uniqueAppointmentsToday.filter(isNovo).map(a => ({ id: a._id.toString(), patient: a.patient?.fullName || 'Não informado', phone: a.patient?.phone || null, time: a.time, specialty: a.specialty, doctor: a.doctor?.fullName || 'Não informado', serviceType: a.serviceType, patientType: a.patientType || (a.isFirstAppointment ? 'novo' : 'recorrente') })),
            recorrentes: uniqueAppointmentsToday.filter(isRecorrente).map(a => ({ id: a._id.toString(), patient: a.patient?.fullName || 'Não informado', phone: a.patient?.phone || null, time: a.time, specialty: a.specialty, doctor: a.doctor?.fullName || 'Não informado', serviceType: a.serviceType, patientType: a.patientType || (a.isFirstAppointment ? 'novo' : 'recorrente') })),
        };
        report.financial.grandTotal = report.financial.totalReceived + report.financial.totalInsuranceProduction;

        const professionalsMap = {};
        const timeSlotsMap = {};
        report.timelines.appointments.forEach((appt) => {
            if (appt.operationalStatus === 'pre_agendado') return;
            const doctor = appt.doctor || "Não informado";
            const time = (appt.time || "").substring(0, 5);
            const value = appt.sessionValue || 0;
            if (!professionalsMap[doctor]) professionalsMap[doctor] = { name: doctor, appointments: [], confirmed: 0, canceled: 0, scheduled: 0, totalValue: 0 };
            professionalsMap[doctor].appointments.push(appt);
            if (isConfirmed(appt.operationalStatus)) professionalsMap[doctor].confirmed++;
            else if (isCanceled(appt.operationalStatus)) professionalsMap[doctor].canceled++;
            else professionalsMap[doctor].scheduled++;
            professionalsMap[doctor].totalValue += value;
            if (!timeSlotsMap[time]) timeSlotsMap[time] = { time, appointments: [], count: 0, stats: { confirmed: 0, canceled: 0, scheduled: 0, revenue: 0, revenueReceived: 0, professionals: [] } };
            const slot = timeSlotsMap[time];
            slot.appointments.push(appt); slot.count++;
            if (isConfirmed(appt.operationalStatus)) slot.stats.confirmed++;
            else if (isCanceled(appt.operationalStatus)) slot.stats.canceled++;
            else slot.stats.scheduled++;
            if (!isCanceled(appt.operationalStatus)) slot.stats.revenue += value;
            if (appt.paidStatus === "Pago no dia") slot.stats.revenueReceived += value;
            if (!slot.stats.professionals.includes(doctor)) slot.stats.professionals.push(doctor);
        });
        report.professionals = Object.values(professionalsMap).map(prof => ({ ...prof, sessionCount: prof.appointments.length, efficiency: prof.appointments.length > 0 ? (prof.confirmed / prof.appointments.length) * 100 : 0 }));
        report.timeSlots = Object.values(timeSlotsMap).map(slot => ({ ...slot, totalSessions: slot.count, stats: { ...slot.stats, confirmationRate: (slot.stats.confirmed + slot.stats.scheduled) > 0 ? (slot.stats.confirmed / (slot.stats.confirmed + slot.stats.scheduled)) * 100 : 0, occupancy: (slot.count / 10) * 100 } })).sort((a, b) => a.time.localeCompare(b.time));

        res.json({
            success: true,
            data: report,
            meta: {
                generatedAt: new Date().toISOString(),
                recordCount: { appointments: uniqueAppointmentsToday.length, payments: filteredPayments.length, professionals: report.professionals.length, timeSlots: report.timeSlots.length },
                byPatientType: { novos: report.summary.appointments.novos, recorrentes: report.summary.appointments.recorrentes },
            },
        });
    } catch (error) {
        console.error("❌ Erro no fechamento diário:", error);
        res.status(500).json({ success: false, error: "Erro ao gerar relatório diário", details: process.env.NODE_ENV === "development" ? error.message : undefined });
    }
});

export default router;
