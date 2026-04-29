/**
 * 🔥 Financial Truth Layer
 *
 * Wrapper único e obrigatório para TODAS as leituras financeiras do sistema.
 *
 * Regra de ouro:
 *   → V2 (Payment ledger) = ÚNICA fonte de verdade para UI e decisões
 *   → V1 (session.isPaid) = SÓ audit shadow, nunca usado como truth
 *
 * Cada leitura faz "shadow comparison" com V1 e loga inconsistência,
 * mas NUNCA deixa V1 influenciar o retorno.
 */

import Payment from '../../models/Payment.js';
import Session from '../../models/Session.js';
import Appointment from '../../models/Appointment.js';
import Package from '../../models/Package.js';
import { LedgerReadServiceV2 } from './ledgerReadService.v2.js';

// Inconsistência detectada mas não propagada — só audit
class V1Inconsistency {
  constructor(type, v1Value, v2Value, entityId, meta = {}) {
    this.type = type;           // 'isPaid' | 'paymentStatus' | 'missing_payment'
    this.v1Value = v1Value;     // o que V1 diz
    this.v2Value = v2Value;     // o que V2 (ledger) diz
    this.entityId = entityId;   // sessionId / appointmentId
    this.meta = meta;
    this.detectedAt = new Date();
  }

  toJSON() {
    return {
      type: this.type,
      v1: this.v1Value,
      v2: this.v2Value,
      entityId: this.entityId,
      ...this.meta,
      detectedAt: this.detectedAt
    };
  }
}

// Logger centralizado para inconsistências
function logInconsistency(inc) {
  // Em produção, isto pode virar um evento ou write em collection de audit
  console.warn(`[FINANCIAL TRUTH] INCONSISTÊNCIA V1→V2: ${inc.type}`, inc.toJSON());
}

// ─────────────────────────────────────────────────────────────
// CORE: Shadow comparison — compara V1 com V2 sem influenciar retorno
// ─────────────────────────────────────────────────────────────

function shadowCompare(sessionDoc, v2Status, entityType = 'session') {
  const inconsistencies = [];

  const v1IsPaid = sessionDoc?.isPaid ?? false;
  const v1PaymentStatus = sessionDoc?.paymentStatus ?? 'unpaid';

  if (v1IsPaid !== v2Status.isPaid) {
    inconsistencies.push(new V1Inconsistency(
      'isPaid',
      v1IsPaid,
      v2Status.isPaid,
      sessionDoc?._id,
      { entityType, v1PaymentStatus, v2PaymentStatus: v2Status.paymentStatus }
    ));
  }

  if (v1PaymentStatus !== v2Status.paymentStatus && v2Status.paymentStatus !== 'unpaid') {
    // Só loga se V2 tem algo diferente de 'unpaid' — evita noise de sessões realmente não pagas
    inconsistencies.push(new V1Inconsistency(
      'paymentStatus',
      v1PaymentStatus,
      v2Status.paymentStatus,
      sessionDoc?._id,
      { entityType, v1IsPaid, v2IsPaid: v2Status.isPaid }
    ));
  }

  for (const inc of inconsistencies) {
    logInconsistency(inc);
  }

  return inconsistencies;
}

// ─────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────

export class FinancialTruthLayer {

  /**
   * Obtém sessão com status financeiro V2 (truth) + shadow V1 (audit)
   */
  static async getSession(sessionId, options = {}) {
    const { populate = [], withAudit = true, session: mongoSession } = options;

    const query = Session.findById(sessionId).session(mongoSession);
    for (const path of populate) query.populate(path);

    const sessionDoc = await query.lean();
    if (!sessionDoc) return null;

    const v2Status = await LedgerReadServiceV2.deriveSessionStatus(sessionId, { session: mongoSession });
    const inconsistencies = withAudit ? shadowCompare(sessionDoc, v2Status, 'session') : [];

    return {
      ...sessionDoc,
      isPaid: v2Status.isPaid,              // ← TRUTH (V2)
      paymentStatus: v2Status.paymentStatus, // ← TRUTH (V2)
      _paymentId: v2Status.paymentId,
      _paymentAmount: v2Status.paymentAmount,
      _paymentMethod: v2Status.paymentMethod,
      _paidAt: v2Status.paidAt,
      _financialSource: 'truth_layer_v2',
      _v1Shadow: withAudit ? {
        isPaid: sessionDoc.isPaid ?? false,
        paymentStatus: sessionDoc.paymentStatus ?? 'unpaid',
        inconsistent: inconsistencies.length > 0,
        inconsistencies: inconsistencies.map(i => i.toJSON())
      } : undefined
    };
  }

  /**
   * Obtém appointment com status financeiro V2 (truth) + shadow V1 (audit)
   */
  static async getAppointment(appointmentId, options = {}) {
    const { populate = [], withAudit = true, session: mongoSession } = options;

    const query = Appointment.findById(appointmentId).session(mongoSession);
    for (const path of populate) query.populate(path);

    const apptDoc = await query.lean();
    if (!apptDoc) return null;

    const v2Status = await LedgerReadServiceV2.deriveAppointmentStatus(appointmentId, { session: mongoSession });
    const inconsistencies = withAudit ? shadowCompare(apptDoc, v2Status, 'appointment') : [];

    return {
      ...apptDoc,
      isPaid: v2Status.isPaid,
      paymentStatus: v2Status.paymentStatus,
      _paymentId: v2Status.paymentId,
      _paymentAmount: v2Status.paymentAmount,
      _paymentMethod: v2Status.paymentMethod,
      _paidAt: v2Status.paidAt,
      _financialSource: 'truth_layer_v2',
      _v1Shadow: withAudit ? {
        isPaid: apptDoc.isPaid ?? false,
        paymentStatus: apptDoc.paymentStatus ?? 'unpaid',
        inconsistent: inconsistencies.length > 0,
        inconsistencies: inconsistencies.map(i => i.toJSON())
      } : undefined
    };
  }

  /**
   * Batch: appointments com truth V2
   */
  static async getAppointments(appointmentIds, options = {}) {
    const { withAudit = true, session: mongoSession } = options;

    if (!appointmentIds?.length) return [];

    const [apptDocs, v2Map] = await Promise.all([
      Appointment.find({ _id: { $in: appointmentIds } })
        .session(mongoSession)
        .lean(),
      LedgerReadServiceV2.deriveBatchAppointmentStatus(appointmentIds, { session: mongoSession })
    ]);

    const docMap = new Map(apptDocs.map(d => [d._id.toString(), d]));
    const results = [];
    let totalInconsistencies = 0;

    for (const aid of appointmentIds) {
      const doc = docMap.get(aid.toString?.() || aid);
      if (!doc) continue;

      const v2Status = v2Map[aid.toString?.() || aid] || {
        isPaid: false, paymentStatus: 'unpaid', paymentId: null,
        paymentAmount: 0, paymentMethod: null, paidAt: null, source: 'ledger_v2'
      };

      const inconsistencies = withAudit ? shadowCompare(doc, v2Status, 'appointment') : [];
      totalInconsistencies += inconsistencies.length;

      results.push({
        ...doc,
        isPaid: v2Status.isPaid,
        paymentStatus: v2Status.paymentStatus,
        _paymentId: v2Status.paymentId,
        _paymentAmount: v2Status.paymentAmount,
        _paymentMethod: v2Status.paymentMethod,
        _paidAt: v2Status.paidAt,
        _financialSource: 'truth_layer_v2',
        _v1Shadow: withAudit ? {
          isPaid: doc.isPaid ?? false,
          paymentStatus: doc.paymentStatus ?? 'unpaid',
          inconsistent: inconsistencies.length > 0,
          inconsistencies: inconsistencies.map(i => i.toJSON())
        } : undefined
      });
    }

    if (totalInconsistencies > 0 && withAudit) {
      console.warn(`[FINANCIAL TRUTH] Batch ${appointmentIds.length} appointments, ${totalInconsistencies} inconsistências V1→V2 detectadas`);
    }

    return results;
  }

  /**
   * Batch: todas as sessões de um pacote ou paciente
   */
  static async getSessions(sessionIds, options = {}) {
    const { withAudit = true, session: mongoSession } = options;

    if (!sessionIds?.length) return [];

    const [sessionDocs, v2Map] = await Promise.all([
      Session.find({ _id: { $in: sessionIds } })
        .session(mongoSession)
        .lean(),
      LedgerReadServiceV2.deriveBatchSessionStatus(sessionIds, { session: mongoSession })
    ]);

    const docMap = new Map(sessionDocs.map(d => [d._id.toString(), d]));
    const results = [];
    let totalInconsistencies = 0;

    for (const sid of sessionIds) {
      const doc = docMap.get(sid.toString?.() || sid);
      if (!doc) continue;

      const v2Status = v2Map[sid.toString?.() || sid] || {
        isPaid: false, paymentStatus: 'unpaid', paymentId: null,
        paymentAmount: 0, paymentMethod: null, paidAt: null, source: 'ledger_v2'
      };

      const inconsistencies = withAudit ? shadowCompare(doc, v2Status, 'session') : [];
      totalInconsistencies += inconsistencies.length;

      results.push({
        ...doc,
        isPaid: v2Status.isPaid,
        paymentStatus: v2Status.paymentStatus,
        _paymentId: v2Status.paymentId,
        _paymentAmount: v2Status.paymentAmount,
        _paymentMethod: v2Status.paymentMethod,
        _paidAt: v2Status.paidAt,
        _financialSource: 'truth_layer_v2',
        _v1Shadow: withAudit ? {
          isPaid: doc.isPaid ?? false,
          paymentStatus: doc.paymentStatus ?? 'unpaid',
          inconsistent: inconsistencies.length > 0,
          inconsistencies: inconsistencies.map(i => i.toJSON())
        } : undefined
      });
    }

    if (totalInconsistencies > 0 && withAudit) {
      console.warn(`[FINANCIAL TRUTH] Batch ${sessionIds.length} sessões, ${totalInconsistencies} inconsistências V1→V2 detectadas`);
    }

    return results;
  }

  /**
   * Snapshot financeiro completo de um paciente
   */
  static async getPatientFinancialSnapshot(patientId, options = {}) {
    const { withAudit = true, session: mongoSession } = options;

    const packages = await Package.find({ patient: patientId })
      .session(mongoSession)
      .populate('sessions')
      .populate('doctor', 'fullName specialty')
      .lean();

    const allSessionIds = packages.flatMap(p =>
      (p.sessions || []).map(s => s._id.toString())
    );

    const sessionTruth = await this.getSessions(allSessionIds, { withAudit, session: mongoSession });
    const sessionTruthMap = new Map(sessionTruth.map(s => [s._id.toString(), s]));

    // Montar pacotes com truth
    const packagesWithTruth = packages.map(pkg => ({
      ...pkg,
      sessions: (pkg.sessions || []).map(s =>
        sessionTruthMap.get(s._id.toString()) || s
      ),
      _financialSource: 'truth_layer_v2'
    }));

    // Métricas resumidas
    const paidSessions = sessionTruth.filter(s => s.isPaid);
    const totalPaid = paidSessions.reduce((sum, s) => sum + (s._paymentAmount || 0), 0);
    const inconsistentCount = sessionTruth.filter(s => s._v1Shadow?.inconsistent).length;

    return {
      patientId,
      packages: packagesWithTruth,
      summary: {
        totalSessions: sessionTruth.length,
        paidSessions: paidSessions.length,
        unpaidSessions: sessionTruth.length - paidSessions.length,
        totalPaidAmount: totalPaid,
        inconsistentSessions: inconsistentCount,
        v1DivergenceRate: allSessionIds.length > 0 ? (inconsistentCount / allSessionIds.length) : 0
      },
      _financialSource: 'truth_layer_v2'
    };
  }

  /**
   * Receita em um período — V2 truth com V1 shadow
   */
  static async getRevenue(startDate, endDate, options = {}) {
    const { withAudit = true, session: mongoSession } = options;

    const payments = await Payment.find({
      status: 'paid',
      paidAt: { $gte: startDate, $lte: endDate }
    })
      .session(mongoSession)
      .lean();

    const totalV2 = payments.reduce((sum, p) => sum + (p.amount || 0), 0);

    // Shadow: quanto V1 dizia no mesmo período? (aproximação por session paidAt)
    let v1Shadow = null;
    if (withAudit) {
      const paidSessionIds = payments.filter(p => p.session).map(p => p.session.toString());
      const sessions = paidSessionIds.length > 0
        ? await Session.find({ _id: { $in: paidSessionIds } }).session(mongoSession).lean()
        : [];

      const v1PaidCount = sessions.filter(s => s.isPaid === true).length;
      const v1UnpaidCount = sessions.filter(s => s.isPaid !== true).length;

      v1Shadow = {
        v1PaidCount,
        v1UnpaidCount,
        v1WouldShowPaid: sessions.length, // V1 marcou todas como paid
        v2PaidCount: payments.length,
        deltaCount: sessions.length - payments.length,
        note: 'V1 marcava sessions como paid sem exigir Payment'
      };
    }

    return {
      period: { start: startDate, end: endDate },
      revenue: totalV2,
      paymentCount: payments.length,
      payments: payments.map(p => ({
        id: p._id,
        amount: p.amount,
        method: p.paymentMethod,
        paidAt: p.paidAt,
        sessionId: p.session,
        appointmentId: p.appointment
      })),
      _financialSource: 'truth_layer_v2',
      _v1Shadow: v1Shadow
    };
  }

  /**
   * Saldo real de um paciente (quanto ele realmente pagou vs quanto deve)
   */
  static async getPatientBalance(patientId, options = {}) {
    const { session: mongoSession } = options;

    const payments = await Payment.find({
      patient: patientId,
      status: 'paid'
    })
      .session(mongoSession)
      .lean();

    const totalPaid = payments.reduce((sum, p) => sum + (p.amount || 0), 0);

    // Débito = total de sessões/appointments que deveriam ser pagas
    // Nota: isso requer regra de negócio específica; aqui usamos valor total dos pacotes
    const packages = await Package.find({ patient: patientId })
      .session(mongoSession)
      .lean();

    const totalPackageValue = packages.reduce((sum, pkg) => {
      const val = pkg.totalValue ?? pkg.price ?? pkg.value ?? 0;
      return sum + val;
    }, 0);

    return {
      patientId,
      totalPaid,
      totalOwed: totalPackageValue,
      balance: totalPaid - totalPackageValue,
      paymentCount: payments.length,
      packageCount: packages.length,
      _financialSource: 'truth_layer_v2'
    };
  }
}

export default FinancialTruthLayer;
