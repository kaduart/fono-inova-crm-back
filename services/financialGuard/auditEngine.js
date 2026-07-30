/**
 * 🔍 Financial Audit Engine
 *
 * Detecta inconsistências financeiras sistêmicas:
 * - Packages com totalPaid divergente do ledger (Payment)
 * - Appointments com paymentStatus inconsistente
 * - Divergência de billingType entre payment e appointment
 * - insurance.status fora do enum do schema (Payment de convênio)
 * - Payments duplicados na mesma session
 * - InsuranceBatch referenciando Payment/Session inexistente
 *
 * auditOrphanSessions/auditOrphanPayments existem no código mas NÃO rodam mais
 * (ver comentário "DEPRECATED" em cada um) — calibração 2026-07-29 confirmou que
 * ambos partiam de premissa falsa pra arquitetura atual (Session/Payment sem
 * Package não é sinônimo de órfão neste sistema) e respondiam por ~88% de um
 * relatório de 6841 issues sem sinal acionável.
 */

import mongoose from 'mongoose';

export class FinancialAuditEngine {
  constructor(db) {
    this.db = db;
    this.issues = [];
  }

  static async run(options = {}) {
    const { mongoUri, dryRun = true } = options;
    await mongoose.connect(mongoUri);
    const db = mongoose.connection.db;
    const engine = new FinancialAuditEngine(db);
    await engine.audit();
    await mongoose.disconnect();
    return engine.report();
  }

  async audit() {
    await this.auditPackageLedger();
    // auditOrphanSessions/auditOrphanPayments DESATIVADOS em 2026-07-29 — ver comentário
    // "DEPRECATED" em cada método. Calibração real (não amostra, contagem completa) mostrou
    // que ambos partem de premissa falsa pra arquitetura atual e geravam ~6000 dos ~6841
    // issues do relatório, sem sinal acionável.
    await this.auditAppointmentPaymentStatus();
    await this.auditBillingTypeMismatch();
    await this.auditInsuranceStatus();
    await this.auditDuplicatePaymentsPerSession();
    await this.auditInsuranceBatchConsistency();
  }

  // ========== 1. PACKAGE LEDGER DIVERGENCE ==========
  async auditPackageLedger() {
    const packages = this.db.collection('packages');
    const payments = this.db.collection('payments');

    const allPackages = await packages.find({}).toArray();

    for (const pkg of allPackages) {
      const pkgPayments = await payments.find({
        package: pkg._id,
        status: 'paid'
      }).toArray();

      const ledgerTotal = pkgPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
      const packageTotal = pkg.totalPaid || 0;
      const diff = Math.abs(ledgerTotal - packageTotal);

      if (diff > 0.01) {
        this.addIssue({
          severity: packageTotal > 0 && pkgPayments.length === 0 ? 'CRITICAL' : 'HIGH',
          category: 'LEDGER_DIVERGENCE',
          packageId: pkg._id.toString(),
          patientId: pkg.patient?.toString(),
          specialty: pkg.sessionType,
          expected: ledgerTotal,
          actual: packageTotal,
          diff,
          paymentsCount: pkgPayments.length,
          details: pkgPayments.length === 0 && packageTotal > 0
            ? 'Package marcado como pago mas NENHUM payment existe'
            : `Soma dos payments (R$ ${ledgerTotal}) ≠ totalPaid do package (R$ ${packageTotal})`
        });
      }
    }
  }

  // ========== 2. ORPHAN SESSIONS ==========
  // ⚠️ DEPRECATED (2026-07-29) — não chamado por audit() mais. Assumia que toda Session
  // deveria pertencer a um Package. Não é verdade na arquitetura atual: sessão avulsa,
  // particular per-session, convênio, liminar e ajustes manuais existem legitimamente sem
  // Package. Confirmado com dado real: 0 sessões com serviceType='package_session' (o único
  // caso em que Package é esperado) estavam sem package — as ~2586-6017 flagadas eram todas
  // dos fluxos legítimos acima, espalhadas continuamente por 18 meses (não é resíduo de
  // migração). Mantido no código como histórico; não reativar sem reformular o critério
  // (ex: cruzar Payment.package existente vs Session.package ausente, não checar isolado).
  async auditOrphanSessions() {
    const sessions = this.db.collection('sessions');
    const packages = this.db.collection('packages');
    const appointments = this.db.collection('appointments');

    const orphanPackage = await sessions.find({
      $or: [
        { package: { $exists: false } },
        { package: null }
      ]
    }).toArray();

    for (const s of orphanPackage) {
      this.addIssue({
        severity: 'HIGH',
        category: 'ORPHAN_SESSION',
        sessionId: s._id.toString(),
        patientId: s.patient?.toString(),
        details: 'Session sem vínculo de package'
      });
    }

    const orphanAppointment = await sessions.find({
      $or: [
        { appointment: { $exists: false } },
        { appointment: null }
      ],
      status: { $nin: ['canceled', 'no_show'] }
    }).toArray();

    for (const s of orphanAppointment) {
      this.addIssue({
        severity: 'MEDIUM',
        category: 'ORPHAN_SESSION',
        sessionId: s._id.toString(),
        patientId: s.patient?.toString(),
        details: 'Session ativa sem vínculo de appointment'
      });
    }
  }

  // ========== 3. ORPHAN PAYMENTS ==========
  // ⚠️ DEPRECATED (2026-07-29) — não chamado por audit() mais. Mesma premissa falsa do
  // auditOrphanSessions: Payment.package == null não significa payment órfão. Confirmado
  // com dado real: 92% dos 584 casos flagados eram billingType='particular' com
  // kind='session_payment'/'manual' — exatamente o padrão de cobrança avulsa/per-session,
  // que por design não referencia Package. Mantido no código como histórico; não reativar
  // sem reformular o critério.
  async auditOrphanPayments() {
    const payments = this.db.collection('payments');

    const orphanPayments = await payments.find({
      $or: [
        { package: { $exists: false } },
        { package: null }
      ],
      status: 'paid'
    }).toArray();

    for (const p of orphanPayments) {
      this.addIssue({
        severity: 'CRITICAL',
        category: 'ORPHAN_PAYMENT',
        paymentId: p._id.toString(),
        patientId: p.patient?.toString(),
        amount: p.amount,
        details: 'Payment PAGO mas sem vínculo de package'
      });
    }
  }

  // ========== 4. APPOINTMENT PAYMENT STATUS ==========
  async auditAppointmentPaymentStatus() {
    const appointments = this.db.collection('appointments');
    const payments = this.db.collection('payments');
    const packages = this.db.collection('packages');

    // Appointments marcados como pagos, exceto liminar/crédito judicial.
    // Liminar: o caixa é reconhecido no recebimento do contrato; a sessão consome
    // crédito. Não existe Payment individual por sessão esperado.
    const paidAppointments = await appointments.find({
      $and: [
        {
          $or: [
            { isPaid: true },
            { paymentStatus: 'paid' },
            { paymentStatus: 'package_paid' }
          ]
        },
        {
          billingType: { $ne: 'liminar' },
          paymentMethod: { $ne: 'liminar_credit' },
          paymentOrigin: { $ne: 'liminar_credit' },
          $or: [
            { liminarContract: { $exists: false } },
            { liminarContract: null }
          ]
        }
      ]
    }).project({
      patient: 1,
      package: 1,
      billingType: 1,
      paymentMethod: 1,
      paymentOrigin: 1,
      paymentStatus: 1,
      isPaid: 1
    }).toArray();

    if (paidAppointments.length === 0) return;

    // Origem financeira válida pode vir de Payment, Package ou recebível convênio.
    const appointmentIds = paidAppointments.map(a => a._id);

    const paidPayments = await payments.find({
      $or: [
        { appointment: { $in: appointmentIds } },
        { appointmentId: { $in: appointmentIds.map(id => id.toString()) } }
      ],
      status: 'paid'
    }).project({ appointment: 1, appointmentId: 1 }).toArray();

    const convenioPayments = await payments.find({
      $or: [
        { appointment: { $in: appointmentIds } },
        { appointmentId: { $in: appointmentIds.map(id => id.toString()) } }
      ],
      billingType: 'convenio',
      status: { $in: ['pending', 'pending_billing', 'billed', 'received'] }
    }).project({ appointment: 1, appointmentId: 1, status: 1 }).toArray();

    const packagesByAppointment = await packages.find({
      appointments: { $in: appointmentIds }
    }).project({ appointments: 1 }).toArray();

    const resolveAppointmentId = (p) => {
      if (p.appointment) return p.appointment.toString();
      if (p.appointmentId) {
        const str = typeof p.appointmentId === 'string' ? p.appointmentId : p.appointmentId.toString();
        if (mongoose.Types.ObjectId.isValid(str)) return str;
      }
      return null;
    };

    const paidByAppointment = new Set();
    for (const p of paidPayments) {
      const id = resolveAppointmentId(p);
      if (id) paidByAppointment.add(id);
    }

    const convenioByAppointment = new Map();
    for (const p of convenioPayments) {
      const id = resolveAppointmentId(p);
      if (id) convenioByAppointment.set(id, p.status);
    }

    const packageByAppointment = new Set();
    for (const pkg of packagesByAppointment) {
      for (const apptId of (pkg.appointments || [])) {
        packageByAppointment.add(apptId?.toString());
      }
    }

    for (const appt of paidAppointments) {
      const apptId = appt._id.toString();
      const hasPaidPayment = paidByAppointment.has(apptId);
      const hasPackage = !!appt.package || packageByAppointment.has(apptId);
      const hasConvenioReceivable = convenioByAppointment.has(apptId);

      const hasFinancialOrigin = hasPaidPayment || hasPackage || hasConvenioReceivable;

      if (!hasFinancialOrigin) {
        const originHint = [];
        if (appt.billingType) originHint.push(`billingType=${appt.billingType}`);
        if (appt.paymentMethod) originHint.push(`method=${appt.paymentMethod}`);
        if (appt.paymentOrigin) originHint.push(`origin=${appt.paymentOrigin}`);

        this.addIssue({
          severity: 'HIGH',
          category: 'GHOST_PAYMENT_STATUS',
          appointmentId: apptId,
          patientId: appt.patient?.toString(),
          paymentStatus: appt.paymentStatus,
          isPaid: appt.isPaid,
          details: `Appointment marcado como pago mas sem origem financeira válida (${originHint.join(' | ') || 'sem metadados'})`
        });
      }
    }
  }

  // ========== 5. BILLING TYPE MISMATCH ==========
  async auditBillingTypeMismatch() {
    const payments = this.db.collection('payments');
    const appointments = this.db.collection('appointments');

    const paymentsWithAppointment = await payments.find({
      appointment: { $exists: true, $ne: null }
    }).toArray();

    for (const p of paymentsWithAppointment) {
      const appt = await appointments.findOne({ _id: p.appointment });
      if (!appt) continue;

      const pType = p.billingType || 'particular';
      const aType = appt.billingType || 'particular';

      if (pType !== aType && aType !== 'particular') {
        this.addIssue({
          severity: 'MEDIUM',
          category: 'BILLING_TYPE_MISMATCH',
          paymentId: p._id.toString(),
          appointmentId: appt._id.toString(),
          paymentBillingType: pType,
          appointmentBillingType: aType,
          details: `Payment billingType (${pType}) ≠ Appointment billingType (${aType})`
        });
      }
    }
  }

  // ========== 6. INSURANCE STATUS FORA DO ENUM (Payment.insurance.status) ==========
  // Schema declara enum: ['pending','pending_billing','billed','received','rejected',null].
  // processReturn (insuranceBatchService.js) escreve via bulkWrite, que não roda os
  // validators do Mongoose — então 'partial'/'glosa' (usados no mapeamento de retorno
  // de lote) podem entrar no banco sem nunca terem sido um valor válido do schema.
  async auditInsuranceStatus() {
    const payments = this.db.collection('payments');
    const validStatuses = ['pending', 'pending_billing', 'billed', 'received', 'rejected', null];

    const invalid = await payments.find({
      billingType: 'convenio',
      'insurance.status': { $nin: validStatuses }
    }).toArray();

    for (const p of invalid) {
      this.addIssue({
        severity: 'HIGH',
        category: 'INSURANCE_STATUS_INVALID',
        paymentId: p._id.toString(),
        patientId: p.patient?.toString(),
        insuranceStatus: p.insurance?.status,
        details: `insurance.status "${p.insurance?.status}" fora do enum do schema — provavelmente escrito via bulkWrite sem validação (ver processReturn)`
      });
    }
  }

  // ========== 7. PAYMENTS DUPLICADOS NA MESMA SESSION ==========
  async auditDuplicatePaymentsPerSession() {
    const payments = this.db.collection('payments');

    const dupes = await payments.aggregate([
      { $match: { session: { $ne: null }, status: { $nin: ['canceled', 'refunded'] } } },
      { $group: { _id: '$session', count: { $sum: 1 }, paymentIds: { $push: '$_id' }, total: { $sum: '$amount' } } },
      { $match: { count: { $gt: 1 } } }
    ]).toArray();

    for (const d of dupes) {
      this.addIssue({
        severity: 'CRITICAL',
        category: 'DUPLICATE_PAYMENT_SESSION',
        sessionId: d._id?.toString(),
        paymentIds: d.paymentIds.map(id => id.toString()),
        count: d.count,
        totalAmount: d.total,
        details: `${d.count} payments ativos apontando pra mesma session — possível cobrança duplicada`
      });
    }
  }

  // ========== 8. INSURANCEBATCH REFERENCIANDO PAYMENT/SESSION INEXISTENTE ==========
  async auditInsuranceBatchConsistency() {
    const batches = this.db.collection('insurancebatches');
    const payments = this.db.collection('payments');
    const sessions = this.db.collection('sessions');

    const allBatches = await batches.find({}).toArray();

    for (const batch of allBatches) {
      for (const s of batch.sessions || []) {
        if (s.payment) {
          const exists = await payments.findOne({ _id: s.payment }, { projection: { _id: 1 } });
          if (!exists) {
            this.addIssue({
              severity: 'HIGH',
              category: 'INSURANCE_BATCH_ORPHAN_REF',
              batchId: batch._id.toString(),
              batchNumber: batch.batchNumber,
              paymentId: s.payment.toString(),
              details: 'InsuranceBatch.sessions[].payment aponta pra Payment que não existe mais'
            });
          }
        }
        if (s.session) {
          const exists = await sessions.findOne({ _id: s.session }, { projection: { _id: 1 } });
          if (!exists) {
            this.addIssue({
              severity: 'HIGH',
              category: 'INSURANCE_BATCH_ORPHAN_REF',
              batchId: batch._id.toString(),
              batchNumber: batch.batchNumber,
              sessionId: s.session.toString(),
              details: 'InsuranceBatch.sessions[].session aponta pra Session que não existe mais'
            });
          }
        }
      }
    }
  }

  addIssue(issue) {
    this.issues.push({
      id: this.issues.length + 1,
      timestamp: new Date().toISOString(),
      ...issue
    });
  }

  report() {
    const bySeverity = { CRITICAL: [], HIGH: [], MEDIUM: [], LOW: [] };
    const byCategory = {};

    for (const issue of this.issues) {
      bySeverity[issue.severity]?.push(issue);
      byCategory[issue.category] = (byCategory[issue.category] || 0) + 1;
    }

    return {
      summary: {
        total: this.issues.length,
        critical: bySeverity.CRITICAL.length,
        high: bySeverity.HIGH.length,
        medium: bySeverity.MEDIUM.length,
        low: bySeverity.LOW.length,
        byCategory
      },
      issues: this.issues
    };
  }
}

export default FinancialAuditEngine;
