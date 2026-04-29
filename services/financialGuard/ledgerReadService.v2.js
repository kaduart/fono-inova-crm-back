/**
 * 📖 Ledger Read Service V2
 *
 * Versão pura do READ layer — NUNCA lê isPaid/paymentStatus dos documentos.
 * DERIVA 100% do ledger (Payment collection).
 *
 * Diferenças da v1:
 * - Sem fallback para document.isPaid
 * - Sem normalização de documento (retorna apenas status)
 * - Source sempre 'ledger_v2'
 */

import Payment from '../../models/Payment.js';

export class LedgerReadServiceV2 {
  static async deriveSessionStatus(sessionId, options = {}) {
    const { session: mongoSession } = options;

    const payment = await Payment.findOne({
      session: sessionId,
      status: { $in: ['paid', 'pending'] }
    })
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
        paidAt: null,
        source: 'ledger_v2'
      };
    }

    return {
      isPaid: payment.status === 'paid',
      paymentStatus: payment.status,
      paymentId: payment._id,
      paymentAmount: payment.amount || 0,
      paymentMethod: payment.paymentMethod,
      paidAt: payment.paidAt || payment.createdAt,
      source: 'ledger_v2'
    };
  }

  static async deriveAppointmentStatus(appointmentId, options = {}) {
    const { session: mongoSession } = options;

    const payment = await Payment.findOne({
      appointment: appointmentId,
      status: { $in: ['paid', 'pending'] }
    })
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
        paidAt: null,
        source: 'ledger_v2'
      };
    }

    return {
      isPaid: payment.status === 'paid',
      paymentStatus: payment.status,
      paymentId: payment._id,
      paymentAmount: payment.amount || 0,
      paymentMethod: payment.paymentMethod,
      paidAt: payment.paidAt || payment.createdAt,
      source: 'ledger_v2'
    };
  }

  static async deriveBatchSessionStatus(sessionIds, options = {}) {
    const { session: mongoSession } = options;

    if (!sessionIds.length) return {};

    const payments = await Payment.find({
      session: { $in: sessionIds },
      status: { $in: ['paid', 'pending'] }
    })
      .session(mongoSession)
      .sort({ createdAt: -1 })
      .lean();

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
        paymentStatus: p.status,
        paymentId: p._id,
        paymentAmount: p.amount || 0,
        paymentMethod: p.paymentMethod,
        paidAt: p.paidAt || p.createdAt,
        source: 'ledger_v2'
      } : {
        isPaid: false,
        paymentStatus: 'unpaid',
        paymentId: null,
        paymentAmount: 0,
        paymentMethod: null,
        paidAt: null,
        source: 'ledger_v2'
      };
    }

    return result;
  }

  static async deriveBatchAppointmentStatus(appointmentIds, options = {}) {
    const { session: mongoSession } = options;

    if (!appointmentIds.length) return {};

    const payments = await Payment.find({
      appointment: { $in: appointmentIds },
      status: { $in: ['paid', 'pending'] }
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
        paymentStatus: p.status,
        paymentId: p._id,
        paymentAmount: p.amount || 0,
        paymentMethod: p.paymentMethod,
        paidAt: p.paidAt || p.createdAt,
        source: 'ledger_v2'
      } : {
        isPaid: false,
        paymentStatus: 'unpaid',
        paymentId: null,
        paymentAmount: 0,
        paymentMethod: null,
        paidAt: null,
        source: 'ledger_v2'
      };
    }

    return result;
  }

  /**
   * Aplica status do ledger em um documento plano
   * NUNCA preserva isPaid/paymentStatus originais
   */
  static applyStatus(doc, status) {
    return {
      ...doc,
      isPaid: status.isPaid,
      paymentStatus: status.paymentStatus,
      _paymentId: status.paymentId,
      _paymentAmount: status.paymentAmount,
      _paymentMethod: status.paymentMethod,
      _paidAt: status.paidAt,
      _financialSource: status.source
    };
  }
}

export default LedgerReadServiceV2;
