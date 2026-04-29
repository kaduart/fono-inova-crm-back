/**
 * 🔗 Financial Reconciliation Engine v1
 *
 * Reconcilia Packages com Payments órfãos (sem vínculo de package).
 * NÃO altera dados — apenas gera matches com score de confiança.
 *
 * Score de match (0-100):
 * - patientId match: 30 pts
 * - amount match (±5%): 25 pts
 * - doctor/specialty match: 20 pts
 * - timeframe match (dentro de ±7 dias do package): 15 pts
 * - payment único (não concorrente): 10 pts
 */

import mongoose from 'mongoose';

export class FinancialReconciliationEngine {
  constructor(db) {
    this.db = db;
    this.matches = [];
  }

  static async run(options = {}) {
    const { mongoUri } = options;
    await mongoose.connect(mongoUri);
    const db = mongoose.connection.db;
    const engine = new FinancialReconciliationEngine(db);
    await engine.reconcile();
    await mongoose.disconnect();
    return engine.report();
  }

  async reconcile() {
    const packages = this.db.collection('packages');
    const payments = this.db.collection('payments');
    const sessions = this.db.collection('sessions');
    const appointments = this.db.collection('appointments');
    const patients = this.db.collection('patients');

    // Buscar packages com divergência de ledger
    // (totalPaid > 0 mas sem payments vinculados)
    const allPackages = await packages.find({
      totalPaid: { $gt: 0 }
    }).toArray();

    for (const pkg of allPackages) {
      const pkgId = pkg._id.toString();
      const patientId = pkg.patient?.toString();
      const sessionValue = pkg.sessionValue || 0;
      const specialty = pkg.sessionType;

      // Verificar se já tem payments vinculados
      const pkgPayments = await payments.countDocuments({
        package: pkg._id,
        status: 'paid'
      });

      if (pkgPayments > 0) continue; // já tem ledger OK

      // Buscar sessions do package para inferir doctor e timeframe
      const pkgSessions = await sessions.find({ package: pkg._id })
        .sort({ date: 1 })
        .limit(50)
        .toArray();

      const doctors = [...new Set(pkgSessions.map(s => s.doctor?.toString()).filter(Boolean))];
      const sessionDates = pkgSessions.map(s => s.date ? new Date(s.date) : null).filter(Boolean);
      const minDate = sessionDates.length ? new Date(Math.min(...sessionDates)) : null;
      const maxDate = sessionDates.length ? new Date(Math.max(...sessionDates)) : null;

      // Buscar payments órfãos do mesmo patient
      const orphanPayments = await payments.find({
        patient: pkg.patient,
        status: 'paid',
        $or: [
          { package: { $exists: false } },
          { package: null }
        ]
      }).sort({ createdAt: -1 }).toArray();

      if (orphanPayments.length === 0) continue;

      const patient = await patients.findOne({ _id: pkg.patient });
      const patientName = patient?.name || patient?.nome || 'N/A';

      for (const p of orphanPayments) {
        const score = this.calculateScore({
          payment: p,
          package: pkg,
          doctors,
          specialty,
          minDate,
          maxDate,
          orphanPayments
        });

        if (score >= 30) { // mínimo: mesmo patient + alguma coisa
          this.matches.push({
            packageId: pkgId,
            patientId,
            patientName,
            specialty,
            sessionValue,
            paymentId: p._id.toString(),
            paymentAmount: p.amount,
            paymentMethod: p.paymentMethod,
            paymentDate: p.createdAt,
            paymentType: p.kind || p.type || 'session_payment',
            doctorMatch: doctors.includes(p.doctor?.toString()),
            amountMatch: Math.abs(p.amount - sessionValue) <= sessionValue * 0.05,
            score,
            confidence: score >= 80 ? 'HIGH' : score >= 60 ? 'MEDIUM' : 'LOW',
            reason: this.buildReason(score, p.amount, sessionValue, doctors.includes(p.doctor?.toString()))
          });
        }
      }
    }
  }

  calculateScore({ payment, package: pkg, doctors, specialty, minDate, maxDate, orphanPayments }) {
    let score = 0;

    // 1. Patient match (base) — 30 pts
    score += 30;

    // 2. Amount match (±5%) — 25 pts
    const sessionValue = pkg.sessionValue || 0;
    if (sessionValue > 0 && Math.abs(payment.amount - sessionValue) <= sessionValue * 0.05) {
      score += 25;
    } else if (sessionValue > 0 && Math.abs(payment.amount - sessionValue) <= sessionValue * 0.15) {
      score += 15; // aproximado
    } else if (payment.amount === pkg.totalPaid) {
      score += 20; // match exato ao totalPaid (caso particular)
    }

    // 3. Doctor/specialty match — 20 pts
    if (doctors.includes(payment.doctor?.toString())) {
      score += 15;
    }
    if (specialty && payment.specialty === specialty) {
      score += 5;
    }

    // 4. Timeframe match — 15 pts
    if (minDate && maxDate && payment.createdAt) {
      const pDate = new Date(payment.createdAt);
      const windowStart = new Date(minDate);
      windowStart.setDate(windowStart.getDate() - 7);
      const windowEnd = new Date(maxDate);
      windowEnd.setDate(windowEnd.getDate() + 7);

      if (pDate >= windowStart && pDate <= windowEnd) {
        score += 15;
      } else if (pDate >= new Date(windowStart.getTime() - 30 * 24 * 60 * 60 * 1000) && pDate <= windowEnd) {
        score += 8; // dentro de 30 dias
      }
    }

    // 5. Payment único (não concorrente) — 10 pts
    // Se só existe 1 payment órfão para esse patient, é mais provável
    if (orphanPayments.length === 1) {
      score += 10;
    } else if (orphanPayments.length <= 3) {
      score += 5;
    }

    return Math.min(100, score);
  }

  buildReason(score, amount, sessionValue, doctorMatch) {
    const parts = [];
    if (score >= 80) parts.push('match muito forte');
    else if (score >= 60) parts.push('match provável');
    else parts.push('match possível');

    if (amount === sessionValue) parts.push('valor exato');
    else if (Math.abs(amount - sessionValue) <= sessionValue * 0.05) parts.push('valor aproximado');

    if (doctorMatch) parts.push('mesmo profissional');

    return parts.join(', ');
  }

  report() {
    // Agrupar por package
    const byPackage = {};
    for (const m of this.matches) {
      if (!byPackage[m.packageId]) {
        byPackage[m.packageId] = {
          packageId: m.packageId,
          patientName: m.patientName,
          patientId: m.patientId,
          specialty: m.specialty,
          sessionValue: m.sessionValue,
          matches: []
        };
      }
      byPackage[m.packageId].matches.push(m);
    }

    // Ordenar matches por score dentro de cada package
    for (const pkg of Object.values(byPackage)) {
      pkg.matches.sort((a, b) => b.score - a.score);
    }

    return {
      summary: {
        totalPackages: Object.keys(byPackage).length,
        totalMatches: this.matches.length,
        highConfidence: this.matches.filter(m => m.confidence === 'HIGH').length,
        mediumConfidence: this.matches.filter(m => m.confidence === 'MEDIUM').length,
        lowConfidence: this.matches.filter(m => m.confidence === 'LOW').length
      },
      packages: Object.values(byPackage)
    };
  }
}

export default FinancialReconciliationEngine;
