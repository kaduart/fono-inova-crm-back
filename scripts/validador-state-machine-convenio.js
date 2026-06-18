#!/usr/bin/env node
/**
 * 🛡️ Validador de State Machine – Convênio
 *
 * Verifica invariantes entre Appointment, Session, Payment e InsuranceGuide.
 *
 * Uso:
 *   cd back && node -r dotenv/config scripts/validador-state-machine-convenio.js
 */

import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';

const MONGO_URI = process.env.MONGO_URI ||
  'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/fono_inova_prod?retryWrites=true&w=majority&appName=Cluster0';

function fmtId(id) {
  if (!id) return null;
  return id.toString ? id.toString() : String(id);
}

function fmtDate(d) {
  if (!d) return null;
  const date = new Date(d);
  return isNaN(date) ? String(d) : date.toISOString();
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  🛡️ VALIDADOR DE STATE MACHINE – CONVÊNIO');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const report = {
    geradoEm: new Date().toISOString(),
    banco: db.databaseName,
    invariantes: []
  };

  // ── Invariante 1: Session completed de convênio sem payment ativo ─────────
  console.log('─── Invariante 1: Session completed de convênio sem payment ativo ───');
  const q1 = {
    status: 'completed',
    $or: [
      { paymentMethod: 'convenio' },
      { paymentOrigin: 'convenio' }
    ],
    $or: [
      { paymentId: { $exists: false } },
      { paymentId: null }
    ]
  };
  const inv1Sessions = await db.collection('sessions').find(q1).toArray();
  console.log(`  ❌ ${inv1Sessions.length} violações\n`);
  report.invariantes.push({
    nome: 'Session completed de convênio sem paymentId',
    descricao: 'Toda session completed de convênio deve ter paymentId válido',
    violacoes: inv1Sessions.length,
    exemplos: inv1Sessions.slice(0, 10).map(s => ({
      sessionId: fmtId(s._id),
      date: fmtDate(s.date),
      status: s.status,
      paymentMethod: s.paymentMethod,
      paymentOrigin: s.paymentOrigin,
      insuranceGuide: s.insuranceGuide ? fmtId(s.insuranceGuide) : null,
      appointmentId: s.appointmentId ? fmtId(s.appointmentId) : null
    }))
  });

  // ── Invariante 2: Appointment cancelado/force_cancelled com session completed ─────────
  console.log('─── Invariante 2: Appointment cancelado com session completed ───');
  const canceledAppointments = await db.collection('appointments').find({
    operationalStatus: { $in: ['canceled', 'force_cancelled'] },
    session: { $exists: true, $ne: null }
  }).toArray();

  const inv2Violations = [];
  for (const appt of canceledAppointments) {
    const session = await db.collection('sessions').findOne({ _id: appt.session });
    if (session && session.status === 'completed') {
      inv2Violations.push({
        appointmentId: fmtId(appt._id),
        appointmentStatus: appt.operationalStatus,
        sessionId: fmtId(session._id),
        sessionStatus: session.status,
        date: fmtDate(appt.date)
      });
    }
  }
  console.log(`  ❌ ${inv2Violations.length} violações\n`);
  report.invariantes.push({
    nome: 'Appointment cancelado com session completed',
    descricao: 'Appointment cancelado/force_cancelled não pode ter session completed',
    violacoes: inv2Violations.length,
    exemplos: inv2Violations.slice(0, 10)
  });

  // ── Invariante 3: Payment cancelado com session completed ─────────
  console.log('─── Invariante 3: Payment cancelado com session completed ───');
  const canceledPayments = await db.collection('payments').find({
    status: 'canceled',
    session: { $exists: true, $ne: null }
  }).toArray();

  const inv3Violations = [];
  for (const pay of canceledPayments) {
    const session = await db.collection('sessions').findOne({ _id: pay.session });
    if (session && session.status === 'completed') {
      inv3Violations.push({
        paymentId: fmtId(pay._id),
        paymentStatus: pay.status,
        sessionId: fmtId(session._id),
        sessionStatus: session.status,
        amount: pay.amount,
        date: fmtDate(pay.paymentDate)
      });
    }
  }
  console.log(`  ❌ ${inv3Violations.length} violações\n`);
  report.invariantes.push({
    nome: 'Payment cancelado com session completed',
    descricao: 'Payment cancelado não pode ter session completed',
    violacoes: inv3Violations.length,
    exemplos: inv3Violations.slice(0, 10)
  });

  // ── Invariante 4: Guia com usedSessions inconsistente ─────────
  console.log('─── Invariante 4: Guia com usedSessions inconsistente ───');
  const guides = await db.collection('insuranceguides').find({}).toArray();
  const inv4Violations = [];

  for (const guide of guides) {
    const realCount = await db.collection('sessions').countDocuments({
      insuranceGuide: guide._id,
      status: 'completed',
      guideConsumed: true
    });

    if (guide.usedSessions !== realCount) {
      inv4Violations.push({
        guideId: fmtId(guide._id),
        guideNumber: guide.number,
        patientId: guide.patientId ? fmtId(guide.patientId) : null,
        usedSessionsNoBanco: guide.usedSessions,
        usedSessionsReal: realCount,
        diferenca: guide.usedSessions - realCount,
        status: guide.status
      });
    }
  }
  console.log(`  ❌ ${inv4Violations.length} violações\n`);
  report.invariantes.push({
    nome: 'InsuranceGuide.usedSessions inconsistente',
    descricao: 'usedSessions deve ser igual ao count de sessions completed com guideConsumed=true',
    violacoes: inv4Violations.length,
    exemplos: inv4Violations.slice(0, 10)
  });

  // ── Invariante 5: Payment ativo sem session correspondente ─────────
  console.log('─── Invariante 5: Payment ativo sem session correspondente ───');
  const activePaymentsNoSession = await db.collection('payments').find({
    billingType: 'convenio',
    status: { $nin: ['canceled', 'refunded'] },
    $or: [
      { session: { $exists: false } },
      { session: null }
    ],
    amount: { $gt: 0 }
  }).toArray();
  console.log(`  ❌ ${activePaymentsNoSession.length} violações\n`);
  report.invariantes.push({
    nome: 'Payment ativo de convênio sem session',
    descricao: 'Payment ativo de convênio deve ter session preenchida',
    violacoes: activePaymentsNoSession.length,
    exemplos: activePaymentsNoSession.slice(0, 10).map(p => ({
      paymentId: fmtId(p._id),
      amount: p.amount,
      status: p.status,
      appointmentId: p.appointment ? fmtId(p.appointment) : null,
      createdAt: fmtDate(p.createdAt)
    }))
  });

  // ── Invariante 6: Payment ativo sem appointment correspondente ─────────
  console.log('─── Invariante 6: Payment ativo sem appointment correspondente ───');
  const activePaymentsNoAppt = await db.collection('payments').find({
    billingType: 'convenio',
    status: { $nin: ['canceled', 'refunded'] },
    $or: [
      { appointment: { $exists: false } },
      { appointment: null }
    ],
    amount: { $gt: 0 }
  }).toArray();
  console.log(`  ❌ ${activePaymentsNoAppt.length} violações\n`);
  report.invariantes.push({
    nome: 'Payment ativo de convênio sem appointment',
    descricao: 'Payment ativo de convênio deve ter appointment preenchido',
    violacoes: activePaymentsNoAppt.length,
    exemplos: activePaymentsNoAppt.slice(0, 10).map(p => ({
      paymentId: fmtId(p._id),
      amount: p.amount,
      status: p.status,
      createdAt: fmtDate(p.createdAt)
    }))
  });

  // ── Invariante 7: Session completed com payment ativo mas session.paymentId null ─────────
  console.log('─── Invariante 7: Session completed com payment ativo mas paymentId null ───');
  const sessionsWithPaymentActiveButNoPaymentId = [];
  const paymentsActive = await db.collection('payments').find({
    status: { $nin: ['canceled', 'refunded'] },
    session: { $exists: true, $ne: null }
  }).toArray();

  const sessionsChecked = new Set();
  for (const pay of paymentsActive) {
    const sess = await db.collection('sessions').findOne({ _id: pay.session });
    if (sess && sess.status === 'completed' && !sess.paymentId) {
      const key = fmtId(sess._id);
      if (!sessionsChecked.has(key)) {
        sessionsChecked.add(key);
        sessionsWithPaymentActiveButNoPaymentId.push({
          sessionId: key,
          paymentId: fmtId(pay._id),
          date: fmtDate(sess.date)
        });
      }
    }
  }
  console.log(`  ❌ ${sessionsWithPaymentActiveButNoPaymentId.length} violações\n`);
  report.invariantes.push({
    nome: 'Session completed com payment ativo mas session.paymentId null',
    descricao: 'Se payment ativo aponta para session completed, session.paymentId deve estar preenchido',
    violacoes: sessionsWithPaymentActiveButNoPaymentId.length,
    exemplos: sessionsWithPaymentActiveButNoPaymentId.slice(0, 10)
  });

  // ── Resumo ─────────
  const totalViolacoes = report.invariantes.reduce((sum, inv) => sum + inv.violacoes, 0);

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  📊 RESUMO');
  console.log('═══════════════════════════════════════════════════════════════');
  for (const inv of report.invariantes) {
    console.log(`  ${inv.nome}: ${inv.violacoes}`);
  }
  console.log(`  ─────────────────────────────`);
  console.log(`  TOTAL DE VIOLAÇÕES: ${totalViolacoes}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Salvar relatório
  const outDir = path.resolve(process.cwd(), 'auditoria-output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `validador-state-machine-convenio-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`Relatório completo salvo em: ${outFile}`);

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('💥 Erro:', err);
  process.exit(1);
});
