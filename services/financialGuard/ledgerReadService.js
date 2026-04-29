/**
 * 📖 Ledger Read Service
 *
 * Fonte única de verdade para leitura de status financeiro.
 * NUNCA lê isPaid/paymentStatus dos documentos — DERIVA do ledger (Payment).
 *
 * Regras:
 * - Session.isPaid = existe Payment pago vinculado à session?
 * - Appointment.paymentStatus = status do Payment vinculado
 * - Se não houver Payment → 'unpaid'
 * - Se houver Payment 'paid' → 'paid'
 * - Se houver Payment 'pending' → 'pending'
 */

import Payment from '../../models/Payment.js';

export class LedgerReadService {
  /**
   * Deriva status financeiro de uma Session a partir do ledger
   */
  static async deriveSessionStatus(sessionId, options = {}) {
    const { session: mongoSession, patientId } = options;

    const query = { session: sessionId };
    if (patientId) query.patient = patientId;

    const payment = await Payment.findOne(query)
      .session(mongoSession)
      .sort({ createdAt: -1 })
      .lean();

    if (!payment) {
      return {
        isPaid: false,
        paymentStatus: 'unpaid',
        paymentId: null,
        paymentAmount: 0,
        paymentMethod: null,
        source: 'ledger_derived'
      };
    }

    return {
      isPaid: payment.status === 'paid',
      paymentStatus: payment.status === 'paid' ? 'paid' : payment.status === 'pending' ? 'pending' : 'unpaid',
      paymentId: payment._id,
      paymentAmount: payment.amount || 0,
      paymentMethod: payment.paymentMethod,
      source: 'ledger_derived'
    };
  }

  /**
   * Deriva status financeiro de um Appointment a partir do ledger
   */
  static async deriveAppointmentStatus(appointmentId, options = {}) {
    const { session: mongoSession, patientId } = options;

    const query = { appointment: appointmentId };
    if (patientId) query.patient = patientId;

    const payment = await Payment.findOne(query)
      .session(mongoSession)
      .sort({ createdAt: -1 })
      .lean();

    if (!payment) {
      return {
        isPaid: false,
        paymentStatus: 'unpaid',
        paymentId: null,
        paymentAmount: 0,
        paymentMethod: null,
        source: 'ledger_derived'
      };
    }

    return {
      isPaid: payment.status === 'paid',
      paymentStatus: payment.status === 'paid' ? 'paid' : payment.status === 'pending' ? 'pending' : 'unpaid',
      paymentId: payment._id,
      paymentAmount: payment.amount || 0,
      paymentMethod: payment.paymentMethod,
      source: 'ledger_derived'
    };
  }

  /**
   * Deriva status financeiro de múltiplas sessions (batch)
   */
  static async deriveBatchSessionStatus(sessionIds, options = {}) {
    const { session: mongoSession } = options;

    const payments = await Payment.find({
      session: { $in: sessionIds }
    })
      .session(mongoSession)
      .sort({ createdAt: -1 })
      .lean();

    // Agrupar por sessionId (pegar o mais recente)
    const paymentMap = {};
    for (const p of payments) {
      const sid = p.session?.toString();
      if (!paymentMap[sid]) paymentMap[sid] = p;
    }

    const result = {};
    for (const sid of sessionIds) {
      const p = paymentMap[sid?.toString?.() || sid];
      result[sid] = p ? {
        isPaid: p.status === 'paid',
        paymentStatus: p.status === 'paid' ? 'paid' : p.status === 'pending' ? 'pending' : 'unpaid',
        paymentId: p._id,
        paymentAmount: p.amount || 0,
        paymentMethod: p.paymentMethod,
        source: 'ledger_derived'
      } : {
        isPaid: false,
        paymentStatus: 'unpaid',
        paymentId: null,
        paymentAmount: 0,
        paymentMethod: null,
        source: 'ledger_derived'
      };
    }

    return result;
  }

  /**
   * Deriva status financeiro de múltiplos appointments (batch)
   */
  static async deriveBatchAppointmentStatus(appointmentIds, options = {}) {
    const { session: mongoSession } = options;

    const payments = await Payment.find({
      appointment: { $in: appointmentIds }
    })
      .session(mongoSession)
      .sort({ createdAt: -1 })
      .lean();

    const paymentMap = {};
    for (const p of payments) {
      const aid = p.appointment?.toString();
      if (!paymentMap[aid]) paymentMap[aid] = p;
    }

    const result = {};
    for (const aid of appointmentIds) {
      const p = paymentMap[aid?.toString?.() || aid];
      result[aid] = p ? {
        isPaid: p.status === 'paid',
        paymentStatus: p.status === 'paid' ? 'paid' : p.status === 'pending' ? 'pending' : 'unpaid',
        paymentId: p._id,
        paymentAmount: p.amount || 0,
        paymentMethod: p.paymentMethod,
        source: 'ledger_derived'
      } : {
        isPaid: false,
        paymentStatus: 'unpaid',
        paymentId: null,
        paymentAmount: 0,
        paymentMethod: null,
        source: 'ledger_derived'
      };
    }

    return result;
  }

  /**
   * Normaliza um objeto Session/Appointment para retorno na API
   * Substitui isPaid/paymentStatus pelos valores derivados do ledger
   */
  static normalizeDocument(doc, derivedStatus) {
    return {
      ...doc,
      isPaid: derivedStatus.isPaid,
      paymentStatus: derivedStatus.paymentStatus,
      _paymentId: derivedStatus.paymentId,
      _paymentAmount: derivedStatus.paymentAmount,
      _paymentMethod: derivedStatus.paymentMethod,
      _financialSource: derivedStatus.source
    };
  }
}

export default LedgerReadService;
