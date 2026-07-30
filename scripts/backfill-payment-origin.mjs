// scripts/backfill-payment-origin.mjs
//
// Fase 1 do plano de normalização de legado (ver plano aprovado em
// /home/user/.claude/plans/crystalline-crafting-penguin.md).
//
// Preenche Session.paymentOrigin e Appointment.paymentOrigin quando estão
// null em registros completed com Package vinculado. Causa raiz confirmada
// por rastreamento de código: ParticularHandler.buildSessionUpdate()
// (services/completeSession/handlers/particularHandler.js:36-56) só seta
// paymentOrigin na Session no complete de sessão avulsa/per-session, nunca
// no Appointment.
//
// Regra: deriva de package.paymentType (fonte estrutural, mesma usada no
// fix ao vivo de restorePackageOnCancel.js):
//   'per-session' -> 'auto_per_session'
//   'full' / ausente -> 'package_prepaid'
//   qualquer outro caso -> AMBÍGUO, não escreve, só reporta
//
// Escreve via driver nativo (db.collection(...).updateOne), sem passar pelo
// Mongoose model, para não disparar os hooks pesados de Session/Appointment
// (consumo de guia, bloqueio de operationalStatus, sync de evento) que não
// fazem sentido numa correção de backfill de um campo.
//
// Sem transação Mongo (mesmo padrão dos outros scripts de migração deste
// repo; hooks da Session pulam de propósito dentro de transação, então usar
// uma aqui teria efeito inverso ao pretendido em outras partes do sistema).
//
// Idempotente por construção: a query de seleção (paymentOrigin: null) já
// exclui documentos corrigidos numa run anterior.
//
// Dry-run é o comportamento DEFAULT (sem flag nenhuma). Só escreve com --apply.
//
// Uso:
//   node scripts/backfill-payment-origin.mjs            (dry-run, gera relatório)
//   node scripts/backfill-payment-origin.mjs --apply     (escreve de verdade)

import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

const APPLY = process.argv.includes('--apply');
const SCRIPT_NAME = 'backfill-payment-origin.mjs';

const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) dotenv.config({ path: envPath });

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) { console.error('❌ MONGO_URI não encontrado.'); process.exit(1); }

// Enums reais dos schemas (models/Session.js:296-302, models/Appointment.js:300-306)
const SESSION_ENUM = ['auto_per_session', 'manual_balance', 'package_prepaid', 'convenio', 'liminar', 'liminar_credit', 'individual', 'updated', 'existing'];
const APPOINTMENT_ENUM = ['auto_per_session', 'manual_balance', 'package_prepaid', 'convenio', 'liminar', 'liminar_credit', 'individual', 'unknown', 'direct', 'pending', 'updated', 'existing'];

function deriveOrigin(pkg) {
  if (!pkg) return { origin: null, reason: 'PACKAGE_NOT_FOUND' };
  if (pkg.paymentType === 'per-session') return { origin: 'auto_per_session', reason: null };
  // 'partial' confirmado via utils/paymentResolver.js:79 — tratado igual a 'full'
  // no fluxo real de complete ("Prioridade 5: Pacote pré-pago (full/partial já
  // pagos anteriormente)"), mesmo type: 'package_prepaid' resultante.
  if (pkg.paymentType === 'full' || pkg.paymentType === 'partial' || pkg.paymentType === undefined || pkg.paymentType === null) {
    return { origin: 'package_prepaid', reason: null };
  }
  return { origin: null, reason: `PAYMENT_TYPE_UNRECOGNIZED:${pkg.paymentType}` };
}

function toCsvRow(fields) {
  return fields.map(f => `"${String(f ?? '').replace(/"/g, '""')}"`).join(',');
}

async function auditCollection(coll, packagesById, { statusField, statusValue, entityName }) {
  const docs = await coll.find({
    [statusField]: statusValue,
    package: { $ne: null },
    paymentOrigin: null,
  }).toArray();

  const changes = [];
  const ambiguous = [];
  const enumList = entityName === 'Session' ? SESSION_ENUM : APPOINTMENT_ENUM;

  for (const doc of docs) {
    const pkg = packagesById.get(String(doc.package));
    const { origin, reason } = deriveOrigin(pkg);

    if (!origin) {
      ambiguous.push({ entity: entityName, id: String(doc._id), packageId: String(doc.package), reason });
      continue;
    }
    if (!enumList.includes(origin)) {
      ambiguous.push({ entity: entityName, id: String(doc._id), packageId: String(doc.package), reason: `ORIGIN_NOT_IN_ENUM:${origin}` });
      continue;
    }

    changes.push({ entity: entityName, id: doc._id, packageId: doc.package, oldValue: null, newValue: origin });
  }

  return { total: docs.length, changes, ambiguous };
}

async function main() {
  console.log(`🔌 Conectando ao MongoDB... ${APPLY ? '[EXECUÇÃO REAL]' : '[DRY-RUN]'}`);
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 30000 });
  const db = mongoose.connection.db;
  console.log('✅ Conectado');

  const sessionsColl = db.collection('sessions');
  const appointmentsColl = db.collection('appointments');
  const packagesColl = db.collection('packages');

  // ── 1. Auditoria (fonte do relatório) ───────────────────────────
  const allPackages = await packagesColl.find({}).project({ paymentType: 1 }).toArray();
  const packagesById = new Map(allPackages.map(p => [String(p._id), p]));

  const sessionAudit = await auditCollection(sessionsColl, packagesById, {
    statusField: 'status', statusValue: 'completed', entityName: 'Session',
  });
  const appointmentAudit = await auditCollection(appointmentsColl, packagesById, {
    statusField: 'operationalStatus', statusValue: 'completed', entityName: 'Appointment',
  });

  const allChanges = [...sessionAudit.changes, ...appointmentAudit.changes];
  const allAmbiguous = [...sessionAudit.ambiguous, ...appointmentAudit.ambiguous];

  console.log('\n════════ AUDITORIA ════════');
  console.log(`Session completed+package sem paymentOrigin: ${sessionAudit.total} (${sessionAudit.changes.length} corrigíveis, ${sessionAudit.ambiguous.length} ambíguos)`);
  console.log(`Appointment completed+package sem paymentOrigin: ${appointmentAudit.total} (${appointmentAudit.changes.length} corrigíveis, ${appointmentAudit.ambiguous.length} ambíguos)`);
  console.log(`Total de escritas planejadas: ${allChanges.length}`);
  console.log(`Total de ambíguos (não serão tocados): ${allAmbiguous.length}`);

  const byRule = {};
  for (const c of allChanges) byRule[c.newValue] = (byRule[c.newValue] || 0) + 1;
  console.log('Por regra aplicada:', JSON.stringify(byRule));

  if (allChanges.length === 0 && allAmbiguous.length === 0) {
    console.log('\nNada para corrigir. Encerrando.');
    await mongoose.disconnect();
    return;
  }

  // ── 2. Relatório (sempre gerado, antes de qualquer escrita) ────
  const reportDir = path.resolve(process.cwd(), 'backups-mongo', `backfill-payment-origin-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(reportDir, { recursive: true });

  const reportRows = allChanges.map(c => ({ entity: c.entity, id: String(c.id), packageId: String(c.packageId), oldValue: c.oldValue, newValue: c.newValue }));
  fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify(reportRows, null, 2));
  const csvHeader = toCsvRow(['entity', 'id', 'packageId', 'oldValue', 'newValue']);
  const csvBody = reportRows.map(r => toCsvRow([r.entity, r.id, r.packageId, r.oldValue, r.newValue])).join('\n');
  fs.writeFileSync(path.join(reportDir, 'report.csv'), `${csvHeader}\n${csvBody}\n`);
  fs.writeFileSync(path.join(reportDir, 'ambiguous.json'), JSON.stringify(allAmbiguous, null, 2));

  console.log(`\n📋 Relatório salvo em: ${reportDir}/report.{json,csv}`);
  console.log(`📋 Ambíguos salvos em: ${reportDir}/ambiguous.json`);
  console.log('\n--- Prévia (primeiras 10 mudanças) ---');
  reportRows.slice(0, 10).forEach(r => console.log(`  ${r.entity} ${r.id} | paymentOrigin: null → ${r.newValue}`));
  if (reportRows.length > 10) console.log(`  ... e mais ${reportRows.length - 10}`);

  if (allAmbiguous.length > 0) {
    console.log('\n--- Prévia de ambíguos (primeiros 10) ---');
    allAmbiguous.slice(0, 10).forEach(a => console.log(`  ${a.entity} ${a.id} | ${a.reason}`));
    if (allAmbiguous.length > 10) console.log(`  ... e mais ${allAmbiguous.length - 10}`);
  }

  // ── 3. Backup completo dos documentos afetados (antes de escrever) ──
  const sessionIds = allChanges.filter(c => c.entity === 'Session').map(c => c.id);
  const appointmentIds = allChanges.filter(c => c.entity === 'Appointment').map(c => c.id);
  const sessionsBefore = sessionIds.length ? await sessionsColl.find({ _id: { $in: sessionIds } }).toArray() : [];
  const appointmentsBefore = appointmentIds.length ? await appointmentsColl.find({ _id: { $in: appointmentIds } }).toArray() : [];
  fs.writeFileSync(path.join(reportDir, 'sessions-before.json'), JSON.stringify(sessionsBefore, null, 2));
  fs.writeFileSync(path.join(reportDir, 'appointments-before.json'), JSON.stringify(appointmentsBefore, null, 2));
  console.log(`💾 Backup salvo: ${sessionsBefore.length} sessions + ${appointmentsBefore.length} appointments em ${reportDir}/`);

  if (!APPLY) {
    console.log('\n🔒 DRY-RUN: nenhuma escrita realizada. Rode com --apply depois de revisar o relatório.');
    await mongoose.disconnect();
    return;
  }

  // ── 4. Execução: updateOne por documento, driver nativo (bypass hooks) ──
  const now = new Date();
  const changeLog = [];
  let sessionsUpdated = 0, appointmentsUpdated = 0;

  const migrationTag = { script: SCRIPT_NAME, version: 1, executedAt: now };

  for (const c of allChanges) {
    const coll = c.entity === 'Session' ? sessionsColl : appointmentsColl;
    // migration: campo de auditoria fora do schema Mongoose (gravado via driver
    // nativo, não passa por strict mode) — permite achar exatamente quais docs
    // essa migração tocou, independente do change-log.json.
    const r = await coll.updateOne({ _id: c.id }, { $set: { paymentOrigin: c.newValue, updatedAt: now, migration: migrationTag } });
    if (r.modifiedCount > 0) {
      if (c.entity === 'Session') sessionsUpdated++; else appointmentsUpdated++;
      changeLog.push({ entity: c.entity, id: String(c.id), field: 'paymentOrigin', oldValue: null, newValue: c.newValue, timestamp: now.toISOString(), changedBy: `script:${SCRIPT_NAME}` });
    }
  }

  fs.writeFileSync(path.join(reportDir, 'change-log.json'), JSON.stringify(changeLog, null, 2));
  console.log(`\n✅ Sessions corrigidas: ${sessionsUpdated} | Appointments corrigidos: ${appointmentsUpdated}`);
  console.log(`📝 Change-log gravado em: ${reportDir}/change-log.json`);

  // ── 5. Re-auditoria pós-fix ──────────────────────────────────────
  const sessionAfter = await auditCollection(sessionsColl, packagesById, { statusField: 'status', statusValue: 'completed', entityName: 'Session' });
  const appointmentAfter = await auditCollection(appointmentsColl, packagesById, { statusField: 'operationalStatus', statusValue: 'completed', entityName: 'Appointment' });

  console.log('\n════════ AUDITORIA PÓS-CORREÇÃO ════════');
  console.log(`Session corrigíveis restantes: ${sessionAfter.changes.length} (esperado: 0)`);
  console.log(`Appointment corrigíveis restantes: ${appointmentAfter.changes.length} (esperado: 0)`);
  console.log(`Ambíguos restantes (esperado, não são pra zerar): ${sessionAfter.ambiguous.length + appointmentAfter.ambiguous.length}`);

  if (sessionAfter.changes.length === 0 && appointmentAfter.changes.length === 0) {
    console.log('\n🎉 Todos os casos corrigíveis foram normalizados.');
  } else {
    console.log('\n⚠️ Ainda há casos corrigíveis — investigar antes de rodar de novo.');
  }

  await mongoose.disconnect();
}

main().catch(err => { console.error('❌ Erro:', err); process.exit(1); });
