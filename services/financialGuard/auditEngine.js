/**
 * 🔍 Financial Audit Engine
 *
 * Detecta inconsistências financeiras sistêmicas:
 * - Packages com totalPaid divergente do ledger (Payment)
 * - Sessions órfãs (sem package ou sem appointment)
 * - Payments fantasmas (sem package, patient ou appointment)
 * - Appointments com paymentStatus inconsistente
 * - Divergência de billingType entre payment e appointment
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
    await this.auditOrphanSessions();
    await this.auditOrphanPayments();
    await this.auditAppointmentPaymentStatus();
    await this.auditBillingTypeMismatch();
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

    const paidAppointments = await appointments.find({
      $or: [
        { isPaid: true },
        { paymentStatus: 'paid' },
        { paymentStatus: 'package_paid' }
      ]
    }).toArray();

    for (const appt of paidAppointments) {
      const apptPayments = await payments.find({
        appointment: appt._id,
        status: 'paid'
      }).toArray();

      if (apptPayments.length === 0 && !appt.package) {
        this.addIssue({
          severity: 'HIGH',
          category: 'GHOST_PAYMENT_STATUS',
          appointmentId: appt._id.toString(),
          patientId: appt.patient?.toString(),
          paymentStatus: appt.paymentStatus,
          isPaid: appt.isPaid,
          details: 'Appointment marcado como pago mas sem payment e sem package'
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
