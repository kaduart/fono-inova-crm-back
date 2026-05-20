#!/usr/bin/env node
/**
 * 🔍 Financial Integrity Audit Script
 * Detecta inconsistências entre Payments, Sessions e Packages
 * que podem distorcer o dashboard financeiro.
 *
 * Uso:
 *   node scripts/financial-integrity-audit.js [--fix] [--month=YYYY-MM] [--patient=ID]
 *
 * Flags:
 *   --fix      Aplica correções automáticas seguras
 *   --month    Filtra por mês específico (ex: 2026-05)
 *   --patient  Filtra por paciente específico
 */

import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI ||
  'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/fono_inova_prod?retryWrites=true&w=majority&appName=Cluster0';

const args = process.argv.slice(2);
const shouldFix = args.includes('--fix');
const monthArg = args.find(a => a.startsWith('--month='))?.split('=')[1];
const patientArg = args.find(a => a.startsWith('--patient='))?.split('=')[1];

let monthStart = null;
let monthEnd = null;
if (monthArg) {
  const [y, m] = monthArg.split('-').map(Number);
  monthStart = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
  monthEnd = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999));
}

async function audit() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  🔍 AUDITORIA DE INTEGRIDADE FINANCEIRA');
  if (monthArg) console.log(`  📅 Mês filtrado: ${monthArg}`);
  if (patientArg) console.log(`  👤 Paciente filtrado: ${patientArg}`);
  if (shouldFix) console.log('  🔧 Modo CORREÇÃO ativado');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const issues = [];

  // ─────────────────────────────────────────────────────────────
  // 1. Sessions com insuranceGuide + paymentMethod='package_prepaid'
  // ─────────────────────────────────────────────────────────────
  console.log('─── 1. Sessions com insuranceGuide + paymentMethod=package_prepaid ───');
  const q1 = {
    insuranceGuide: { $exists: true, $ne: null },
    paymentMethod: 'package_prepaid',
  };
  if (monthStart) q1.date = { $gte: monthStart, $lte: monthEnd };
  if (patientArg) q1.patient = new mongoose.Types.ObjectId(patientArg);

  const s1 = await db.collection('sessions').find(q1).toArray();
  if (s1.length === 0) {
    console.log('   ✅ Nenhuma inconsistência encontrada.\n');
  } else {
    console.log(`   ⚠️  ${s1.length} sessions inconsistentes:`);
    for (const s of s1) {
      const dt = s.date ? s.date.toISOString().slice(0, 10) : 'null';
      const msg = `   [${s._id}] ${dt} | R$ ${(s.sessionValue || 0).toFixed(2)} | patient=${s.patient} | package=${s.package}`;
      console.log(msg);
      issues.push({ type: 'session_package_prepaid_with_guide', severity: 'error', session: s._id, details: msg });

      if (shouldFix) {
        await db.collection('sessions').updateOne(
          { _id: s._id },
          { $set: { paymentMethod: 'convenio', paymentOrigin: 'convenio', updatedAt: new Date() } }
        );
        console.log('      🔧 Corrigido: paymentMethod→convenio, paymentOrigin→convenio');
      }
    }
    console.log('');
  }

  // ─────────────────────────────────────────────────────────────
  // 2. Sessions com insuranceGuide mas paymentMethod != 'convenio'
  // ─────────────────────────────────────────────────────────────
  console.log('─── 2. Sessions com insuranceGuide mas paymentMethod != convenio ───');
  const q2 = {
    insuranceGuide: { $exists: true, $ne: null },
    paymentMethod: { $nin: ['convenio', null, ''] },
  };
  if (monthStart) q2.date = { $gte: monthStart, $lte: monthEnd };
  if (patientArg) q2.patient = new mongoose.Types.ObjectId(patientArg);

  const s2 = await db.collection('sessions').find(q2).toArray();
  if (s2.length === 0) {
    console.log('   ✅ Nenhuma inconsistência encontrada.\n');
  } else {
    console.log(`   ⚠️  ${s2.length} sessions inconsistentes:`);
    for (const s of s2) {
      const dt = s.date ? s.date.toISOString().slice(0, 10) : 'null';
      const msg = `   [${s._id}] ${dt} | method=${s.paymentMethod} | origin=${s.paymentOrigin} | patient=${s.patient}`;
      console.log(msg);
      issues.push({ type: 'session_guide_with_wrong_method', severity: 'error', session: s._id, details: msg });
    }
    console.log('');
  }

  // ─────────────────────────────────────────────────────────────
  // 3. Payments paid com billingType != paymentMethod
  // ─────────────────────────────────────────────────────────────
  console.log('─── 3. Payments paid com billingType != paymentMethod ───');
  const q3 = { status: 'paid', billingType: { $exists: true, $ne: null }, paymentMethod: { $exists: true, $ne: null } };
  if (monthStart) {
    q3.$or = [
      { financialDate: { $gte: monthStart, $lte: monthEnd } },
      { financialDate: { $exists: false }, paymentDate: { $gte: monthStart, $lte: monthEnd } },
      { financialDate: null, paymentDate: { $gte: monthStart, $lte: monthEnd } },
    ];
  }
  if (patientArg) q3.patientId = patientArg;

  const p3 = await db.collection('payments').find(q3).toArray();
  const mismatches = [];
  for (const p of p3) {
    const bt = (p.billingType || '').toLowerCase();
    const pm = (p.paymentMethod || '').toLowerCase();
    if (bt !== pm && bt !== 'particular' && !(bt === 'liminar' && pm === 'liminar_credit')) {
      mismatches.push(p);
    }
  }
  if (mismatches.length === 0) {
    console.log('   ✅ Nenhuma inconsistência encontrada.\n');
  } else {
    console.log(`   ⚠️  ${mismatches.length} payments inconsistentes:`);
    for (const p of mismatches) {
      const dt = p.paymentDate ? p.paymentDate.toISOString().slice(0, 10) : 'null';
      const msg = `   [${p._id}] ${dt} | R$ ${p.amount.toFixed(2)} | billing=${p.billingType} | method=${p.paymentMethod} | patient=${p.patientId}`;
      console.log(msg);
      issues.push({ type: 'payment_billing_mismatch', severity: 'warning', payment: p._id, details: msg });

      if (shouldFix) {
        await db.collection('payments').updateOne(
          { _id: p._id },
          { $set: { billingType: p.paymentMethod, updatedAt: new Date() } }
        );
        console.log(`      🔧 Corrigido: billingType→${p.paymentMethod}`);
      }
    }
    console.log('');
  }

  // ─────────────────────────────────────────────────────────────
  // 4. Packages tipo 'convenio' com sessions paymentMethod != 'convenio'
  // ─────────────────────────────────────────────────────────────
  console.log('─── 4. Packages convenio com sessions de método diferente ───');
  const convPackages = await db.collection('packages').find({
    $or: [{ type: 'convenio' }, { model: 'convenio' }],
  }).toArray();

  let pkgIssues = 0;
  for (const pkg of convPackages) {
    if (!pkg.sessions || pkg.sessions.length === 0) continue;
    const sessionIds = pkg.sessions.map(id =>
      typeof id === 'string' ? new mongoose.Types.ObjectId(id) : id
    );
    const q4 = {
      _id: { $in: sessionIds },
      paymentMethod: { $nin: ['convenio', null, ''] },
    };
    if (monthStart) q4.date = { $gte: monthStart, $lte: monthEnd };

    const badSess = await db.collection('sessions').find(q4).toArray();
    for (const s of badSess) {
      const dt = s.date ? s.date.toISOString().slice(0, 10) : 'null';
      const msg = `   [${s._id}] ${dt} | method=${s.paymentMethod} | origin=${s.paymentOrigin} | package=${pkg._id}`;
      console.log(msg);
      issues.push({ type: 'package_convenio_session_wrong_method', severity: 'error', session: s._id, package: pkg._id, details: msg });
      pkgIssues++;

      if (shouldFix) {
        await db.collection('sessions').updateOne(
          { _id: s._id },
          { $set: { paymentMethod: 'convenio', paymentOrigin: 'convenio', updatedAt: new Date() } }
        );
        console.log('      🔧 Corrigido: paymentMethod→convenio, paymentOrigin→convenio');
      }
    }
  }
  if (pkgIssues === 0) {
    console.log('   ✅ Nenhuma inconsistência encontrada.\n');
  } else {
    console.log(`   ⚠️  ${pkgIssues} sessions inconsistentes.\n`);
  }

  // ─────────────────────────────────────────────────────────────
  // 5. Sessions com sessionValue anômalo (> 200 para convênio)
  // ─────────────────────────────────────────────────────────────
  console.log('─── 5. Sessions convênio com sessionValue > 200 (anômalo) ───');
  const q5 = {
    sessionValue: { $gt: 200 },
    $or: [
      { insuranceGuide: { $exists: true, $ne: null } },
      { paymentMethod: 'convenio' },
      { paymentOrigin: 'convenio' },
    ],
  };
  if (monthStart) q5.date = { $gte: monthStart, $lte: monthEnd };
  if (patientArg) q5.patient = new mongoose.Types.ObjectId(patientArg);

  const s5 = await db.collection('sessions').find(q5).toArray();
  if (s5.length === 0) {
    console.log('   ✅ Nenhuma anomalia encontrada.\n');
  } else {
    console.log(`   ⚠️  ${s5.length} sessions com valor anômalo:`);
    for (const s of s5) {
      const dt = s.date ? s.date.toISOString().slice(0, 10) : 'null';
      const msg = `   [${s._id}] ${dt} | R$ ${s.sessionValue} | method=${s.paymentMethod} | patient=${s.patient}`;
      console.log(msg);
      issues.push({ type: 'session_high_value_convenio', severity: 'warning', session: s._id, details: msg });
    }
    console.log('');
  }

  // ─────────────────────────────────────────────────────────────
  // 6. Resumo
  // ─────────────────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  📊 RESUMO');
  console.log('═══════════════════════════════════════════════════════════════');

  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');

  console.log(`   Erros:   ${errors.length}`);
  console.log(`   Avisos:  ${warnings.length}`);
  console.log(`   Total:   ${issues.length}`);

  if (shouldFix && issues.length > 0) {
    console.log(`\n   🔧 ${issues.filter(i => i.type !== 'session_high_value_convenio').length} correções aplicadas.`);
  }

  if (errors.length > 0 && !shouldFix) {
    console.log('\n   ⚠️  Execute com --fix para aplicar correções automáticas seguras.');
  }

  console.log('\n═══════════════════════════════════════════════════════════════\n');

  await mongoose.disconnect();
  process.exit(errors.length > 0 ? 1 : 0);
}

audit().catch(err => {
  console.error('💥 Erro na auditoria:', err);
  process.exit(1);
});
