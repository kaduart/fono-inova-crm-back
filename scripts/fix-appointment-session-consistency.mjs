// scripts/fix-appointment-session-consistency.mjs
//
// Corrige Session.doctor / Session.time / Session.date para bater com o
// Appointment vinculado (mesmo appointmentId), tratando Appointment como
// fonte de verdade (é o que o usuário edita e o que alimenta a agenda).
//
// Gera relatório de mudanças ANTES de escrever (dry-run sempre roda primeiro),
// faz backup dos documentos Session afetados, corrige registro a registro
// (não updateMany cego) e grava um change-log com appointmentId, sessionId,
// campo, valor antigo, valor novo, timestamp e responsável.
//
// Ao final da execução real, roda a mesma auditoria de novo e imprime os
// contadores finais (esperado: tudo zero).
//
// NÃO apaga nenhum documento. Não toca em sessions completed/canceled.
//
// Uso:
//   node scripts/fix-appointment-session-consistency.mjs --dry-run
//   node scripts/fix-appointment-session-consistency.mjs

import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

const DRY_RUN = process.argv.includes('--dry-run');
const SCRIPT_NAME = 'fix-appointment-session-consistency.mjs';

const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) dotenv.config({ path: envPath });

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) { console.error('❌ MONGO_URI não encontrado.'); process.exit(1); }

function toCsvRow(fields) {
  return fields.map(f => `"${String(f ?? '').replace(/"/g, '""')}"`).join(',');
}

async function runAudit(db) {
  const appointmentsColl = db.collection('appointments');
  const sessionsColl = db.collection('sessions');
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const appts = await appointmentsColl.find({
    date: { $gte: startOfToday },
    operationalStatus: { $in: ['pre_agendado', 'scheduled', 'confirmed'] },
  }).project({ _id: 1, time: 1, date: 1, doctor: 1, patient: 1 }).toArray();

  const apptIds = appts.map(a => a._id);
  const sessions = await sessionsColl.find({ appointmentId: { $in: apptIds } })
    .project({ _id: 1, appointmentId: 1, time: 1, date: 1, doctor: 1, status: 1 }).toArray();
  const sessionByAppt = new Map(sessions.map(s => [String(s.appointmentId), s]));

  let doctorMismatch = 0, timeMismatch = 0, dateMismatch = 0, sessionMissing = 0;
  const changes = [];

  for (const a of appts) {
    const s = sessionByAppt.get(String(a._id));
    if (!s) { sessionMissing++; continue; }
    if (s.status === 'completed' || s.status === 'canceled') continue;

    const aDateStr = new Date(a.date).toISOString().split('T')[0];
    const sDateStr = new Date(s.date).toISOString().split('T')[0];

    if (String(s.doctor) !== String(a.doctor)) {
      doctorMismatch++;
      changes.push({ appointmentId: a._id, sessionId: s._id, patient: a.patient, field: 'doctor', oldValue: String(s.doctor), newValue: String(a.doctor) });
    }
    if (s.time !== a.time) {
      timeMismatch++;
      changes.push({ appointmentId: a._id, sessionId: s._id, patient: a.patient, field: 'time', oldValue: s.time, newValue: a.time });
    }
    if (aDateStr !== sDateStr) {
      dateMismatch++;
      changes.push({ appointmentId: a._id, sessionId: s._id, patient: a.patient, field: 'date', oldValue: sDateStr, newValue: aDateStr, newValueRaw: a.date });
    }
  }

  return { doctorMismatch, timeMismatch, dateMismatch, sessionMissing, changes, totalAppointments: appts.length };
}

async function main() {
  console.log(`🔌 Conectando ao MongoDB... ${DRY_RUN ? '[DRY-RUN]' : '[EXECUÇÃO REAL]'}`);
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 30000 });
  const db = mongoose.connection.db;
  console.log('✅ Conectado');

  const sessionsColl = db.collection('sessions');

  // ── 1. Auditoria (fonte do relatório de mudanças) ──────────────
  const before = await runAudit(db);
  console.log('\n════════ ANTES DA CORREÇÃO ════════');
  console.log(`Appointments analisados: ${before.totalAppointments}`);
  console.log(`Doctor divergente: ${before.doctorMismatch} | Time divergente: ${before.timeMismatch} | Date divergente: ${before.dateMismatch} | Sem session: ${before.sessionMissing}`);
  console.log(`Total de mudanças planejadas: ${before.changes.length}`);

  if (before.changes.length === 0) {
    console.log('\nNada para corrigir. Encerrando.');
    await mongoose.disconnect();
    return;
  }

  // ── 2. Relatório de mudanças (dry-run sempre gera, antes de qualquer escrita) ──
  const reportDir = path.resolve(process.cwd(), 'backups-mongo', `fix-appointment-session-consistency-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(reportDir, { recursive: true });

  const reportRows = before.changes.map(c => ({
    appointmentId: String(c.appointmentId),
    sessionId: String(c.sessionId),
    patient: String(c.patient),
    field: c.field,
    oldValue: c.oldValue,
    newValue: c.newValue,
  }));

  fs.writeFileSync(path.join(reportDir, 'changes-report.json'), JSON.stringify(reportRows, null, 2));
  const csvHeader = toCsvRow(['appointmentId', 'sessionId', 'patient', 'field', 'oldValue', 'newValue']);
  const csvBody = reportRows.map(r => toCsvRow([r.appointmentId, r.sessionId, r.patient, r.field, r.oldValue, r.newValue])).join('\n');
  fs.writeFileSync(path.join(reportDir, 'changes-report.csv'), `${csvHeader}\n${csvBody}\n`);

  console.log(`\n📋 Relatório de mudanças salvo em: ${reportDir}/changes-report.{json,csv}`);
  console.log('\n--- Prévia (primeiras 10 mudanças) ---');
  reportRows.slice(0, 10).forEach(r => console.log(`  session=${r.sessionId} | ${r.field}: ${r.oldValue} → ${r.newValue}`));
  if (reportRows.length > 10) console.log(`  ... e mais ${reportRows.length - 10}`);

  // ── 3. Backup dos documentos Session afetados (completo, antes de escrever) ──
  const affectedSessionIds = [...new Set(before.changes.map(c => String(c.sessionId)))];
  const sessionsBefore = await sessionsColl.find({ _id: { $in: affectedSessionIds.map(id => new mongoose.Types.ObjectId(id)) } }).toArray();
  fs.writeFileSync(path.join(reportDir, 'sessions-before.json'), JSON.stringify(sessionsBefore, null, 2));
  console.log(`💾 Backup de ${sessionsBefore.length} sessions salvo em: ${reportDir}/sessions-before.json`);

  if (DRY_RUN) {
    console.log('\n🔒 DRY-RUN: nenhuma escrita realizada.');
    await mongoose.disconnect();
    return;
  }

  // ── 4. Execução: registro a registro (não updateMany cego) ────
  // Agrupa mudanças por sessionId (uma session pode ter mais de um campo divergente)
  const changesBySession = new Map();
  for (const c of before.changes) {
    const key = String(c.sessionId);
    if (!changesBySession.has(key)) changesBySession.set(key, []);
    changesBySession.get(key).push(c);
  }

  const changeLog = [];
  let sessionsUpdated = 0;
  const now = new Date();

  for (const [sessionId, fieldChanges] of changesBySession) {
    const setFields = { updatedAt: now };
    for (const c of fieldChanges) {
      if (c.field === 'doctor') setFields.doctor = new mongoose.Types.ObjectId(c.newValue);
      if (c.field === 'time') setFields.time = c.newValue;
      if (c.field === 'date') setFields.date = c.newValueRaw;
    }

    const r = await sessionsColl.updateOne({ _id: new mongoose.Types.ObjectId(sessionId) }, { $set: setFields });
    if (r.modifiedCount > 0) sessionsUpdated++;

    for (const c of fieldChanges) {
      changeLog.push({
        appointmentId: String(c.appointmentId),
        sessionId,
        field: c.field,
        oldValue: c.oldValue,
        newValue: c.field === 'date' ? new Date(c.newValueRaw).toISOString().split('T')[0] : c.newValue,
        timestamp: now.toISOString(),
        changedBy: `script:${SCRIPT_NAME}`,
      });
    }
  }

  fs.writeFileSync(path.join(reportDir, 'change-log.json'), JSON.stringify(changeLog, null, 2));
  console.log(`\n✅ Sessions corrigidas: ${sessionsUpdated} (de ${changesBySession.size} sessions com divergência)`);
  console.log(`📝 Change-log gravado em: ${reportDir}/change-log.json`);

  // ── 5. Re-auditoria pós-fix ─────────────────────────────────────
  const after = await runAudit(db);
  console.log('\n════════ AUDITORIA PÓS-CORREÇÃO ════════');
  console.log(`Doctor divergente: ${after.doctorMismatch}`);
  console.log(`Time divergente:   ${after.timeMismatch}`);
  console.log(`Date divergente:   ${after.dateMismatch}`);
  console.log(`Sem session:       ${after.sessionMissing}`);

  if (after.doctorMismatch === 0 && after.timeMismatch === 0 && after.dateMismatch === 0 && after.sessionMissing === 0) {
    console.log('\n🎉 Tudo consistente.');
  } else {
    console.log('\n⚠️ Ainda existe divergência — provavelmente outro fluxo escrevendo fora de sincronia.');
  }

  await mongoose.disconnect();
}

main().catch(err => { console.error('❌ Erro:', err); process.exit(1); });
