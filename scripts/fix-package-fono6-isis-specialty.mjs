/**
 * CORREÇÃO PONTUAL — pacote FONO-6 da paciente Isis Caldas Rebelatto (profissional Luis Henrique, TO).
 *
 * DRY-RUN por padrão (só leitura). Só escreve com --apply.
 *
 *   node scripts/fix-package-fono6-isis-specialty.mjs            # dry-run
 *   node scripts/fix-package-fono6-isis-specialty.mjs --apply    # aplica (transação + snapshot antes)
 *
 * O que muda (tudo no pacote 6a343eea9dcf417d494e35d9):
 *   1. Package.sessionType/specialty  fonoaudiologia -> terapia_ocupacional
 *   2. Package.sequenceNumber         6 -> próximo número livre de TO da paciente (count+1, mesma regra do createPackageV2)
 *   3. Package.sessionsDone           -1 -> nº de sessões completed do pacote (invariante: consumo só no complete)
 *   4. Appointments CANCELADOS do pacote com specialty fono  -> terapia_ocupacional
 *   5. Sessions CANCELADAS do pacote com sessionType fono    -> 'terapia ocupacional' (mesmo formato das irmãs)
 *
 * NÃO toca: Payments, financeiro do pacote (totalPaid/balance/financialStatus), appointments/sessions
 * ativas ou concluídas (já são TO), PackagesView (praticamente sem uso: 1 doc / 313 pacotes).
 *
 * Escrita via driver cru (updateOne) de propósito: evita hooks do Mongoose — ver memória
 * "Session findByIdAndUpdate footgun" (update de Session sem {new:true} pode reativar sessão cancelada).
 * Cada updateOne tem as pré-condições no filtro e o script aborta (rollback) se algum não casar.
 */
import fs from 'fs';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const APPLY = process.argv.includes('--apply');
const { ObjectId } = mongoose.Types;

const PKG_ID = new ObjectId('6a343eea9dcf417d494e35d9');
const LUIS_ID = new ObjectId('6840aa2f928a20e92ab13be8');
const ISIS_ID = new ObjectId('685b0cfaaec14c7163585b5b');
const TARGET = 'terapia_ocupacional';
const TARGET_SESSION_LABEL = 'terapia ocupacional';

const fail = (msg) => { console.error(`\n❌ ABORTADO: ${msg}`); process.exit(1); };

await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
const db = mongoose.connection.db;
const packages = db.collection('packages');
const appointments = db.collection('appointments');
const sessions = db.collection('sessions');

// ───────── Pré-condições (tudo precisa estar exatamente como auditado em 2026-09-21) ─────────
const pkg = await packages.findOne({ _id: PKG_ID });
if (!pkg) fail('pacote não encontrado');
if (String(pkg.doctor) !== String(LUIS_ID) || String(pkg.patient) !== String(ISIS_ID)) fail('profissional/paciente do pacote não batem');
if (pkg.sessionType !== 'fonoaudiologia' || pkg.specialty !== 'fonoaudiologia') fail(`pacote já não está fonoaudiologia (${pkg.sessionType}/${pkg.specialty}) — talvez já corrigido`);
if (pkg.sequenceNumber !== 6) fail(`sequenceNumber esperado 6, atual ${pkg.sequenceNumber}`);
if (pkg.sessionsDone !== -1) fail(`sessionsDone esperado -1, atual ${pkg.sessionsDone}`);

const doctor = await db.collection('doctors').findOne({ _id: LUIS_ID }, { projection: { fullName: 1, specialty: 1 } });
if (doctor?.specialty !== TARGET) fail(`especialidade do profissional é ${doctor?.specialty}, esperado ${TARGET}`);

const appts = await appointments.find({ package: PKG_ID }).toArray();
const sess = await sessions.find({ package: PKG_ID }).toArray();
const canceledAppts = appts.filter((a) => a.operationalStatus === 'canceled' && a.specialty === 'fonoaudiologia');
const canceledSess = sess.filter((s) => s.status === 'canceled' && s.sessionType === 'fonoaudiologia');
const completedSess = sess.filter((s) => s.status === 'completed');
const activeOrDoneAppts = appts.filter((a) => a.operationalStatus !== 'canceled');

if (canceledAppts.length !== 2 || canceledSess.length !== 2) fail(`esperado 2 appointments e 2 sessions cancelados fono, achei ${canceledAppts.length}/${canceledSess.length}`);
if (activeOrDoneAppts.some((a) => a.specialty !== TARGET)) fail('há appointment ativo/concluído que não é TO — escopo diferente do auditado');
if (completedSess.length !== 1) fail(`esperado 1 session completed, achei ${completedSess.length}`);

const toPackages = await packages.find({ patient: ISIS_ID, sessionType: TARGET }, { projection: { sequenceNumber: 1 } }).toArray();
const usedTo = new Set(toPackages.map((p) => p.sequenceNumber));
const newSeq = toPackages.length + 1; // mesma regra do createPackageV2 (count+1)
if (usedTo.has(newSeq)) fail(`número ${newSeq} já usado por outro pacote TO da paciente (${[...usedTo]})`);

const newSessionsDone = completedSess.length;

// ───────── Plano ─────────
console.log(APPLY ? '=== MODO APPLY ===' : '=== DRY-RUN (nada será escrito) ===');
console.log(`Pacote ${PKG_ID}  paciente=Isis  profissional=${doctor.fullName} (${doctor.specialty})`);
console.log(`  1. sessionType/specialty : fonoaudiologia -> ${TARGET}`);
console.log(`  2. sequenceNumber        : 6 -> ${newSeq}   (TO da paciente hoje: ${[...usedTo].sort()})`);
console.log(`  3. sessionsDone          : -1 -> ${newSessionsDone}   (sessions completed no pacote: ${completedSess.length})`);
console.log(`  4. appointments cancelados (${canceledAppts.length}): ${canceledAppts.map((a) => `${a._id} ${a.date.toISOString().slice(0, 10)}`).join(' | ')}  specialty fono -> ${TARGET}, sessionType ${JSON.stringify(canceledAppts.map((a) => a.sessionType))} -> ${TARGET}`);
console.log(`  5. sessions canceladas   (${canceledSess.length}): ${canceledSess.map((s) => `${s._id} ${s.date.toISOString().slice(0, 10)}`).join(' | ')}  sessionType fonoaudiologia -> '${TARGET_SESSION_LABEL}'`);
console.log(`\n  Numeração: createPackageV2 agora usa max+1 (nextSequenceNumber.js) → próximo FONO da paciente = FONO-9 (sem colidir com o FONO-8 existente). Requer o deploy dessa mudança do backend.`);

if (!APPLY) {
  console.log('\nDry-run concluído. Nenhuma escrita feita. Rode com --apply após autorização.');
  await mongoose.disconnect();
  process.exit(0);
}

// ───────── APPLY ─────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const snapshotPath = new URL(`./_snapshot-fono6-isis-${stamp}.json`, import.meta.url);
fs.writeFileSync(snapshotPath, JSON.stringify({ takenAt: new Date(), package: pkg, appointments: appts, sessions: sess }, null, 2));
console.log(`\nSnapshot ANTES gravado em: ${snapshotPath.pathname}`);

const mongoSession = await mongoose.startSession();
try {
  await mongoSession.withTransaction(async () => {
    const now = new Date();

    const r1 = await packages.updateOne(
      { _id: PKG_ID, sessionType: 'fonoaudiologia', specialty: 'fonoaudiologia', sequenceNumber: 6, sessionsDone: -1 },
      { $set: { sessionType: TARGET, specialty: TARGET, sequenceNumber: newSeq, sessionsDone: newSessionsDone, updatedAt: now } },
      { session: mongoSession }
    );
    if (r1.matchedCount !== 1) throw new Error(`package: matched ${r1.matchedCount}, esperado 1`);

    const r2 = await appointments.updateMany(
      { _id: { $in: canceledAppts.map((a) => a._id) }, package: PKG_ID, operationalStatus: 'canceled', specialty: 'fonoaudiologia' },
      { $set: { specialty: TARGET, sessionType: TARGET } },
      { session: mongoSession }
    );
    if (r2.matchedCount !== 2 || r2.modifiedCount !== 2) throw new Error(`appointments: matched ${r2.matchedCount}/modified ${r2.modifiedCount}, esperado 2/2`);

    const r3 = await sessions.updateMany(
      { _id: { $in: canceledSess.map((s) => s._id) }, package: PKG_ID, status: 'canceled', sessionType: 'fonoaudiologia' },
      { $set: { sessionType: TARGET_SESSION_LABEL } },
      { session: mongoSession }
    );
    if (r3.matchedCount !== 2 || r3.modifiedCount !== 2) throw new Error(`sessions: matched ${r3.matchedCount}/modified ${r3.modifiedCount}, esperado 2/2`);
  });
  console.log('✅ Transação confirmada.');
} catch (err) {
  console.error('❌ Falhou — transação revertida, nada foi gravado:', err.message);
  process.exitCode = 1;
} finally {
  await mongoSession.endSession();
}

// Verificação pós-escrita (leitura)
const after = await packages.findOne({ _id: PKG_ID }, { projection: { sessionType: 1, specialty: 1, sequenceNumber: 1, sessionsDone: 1, status: 1 } });
const afterSess = await sessions.find({ package: PKG_ID }, { projection: { status: 1, sessionType: 1 } }).toArray();
const afterAppts = await appointments.find({ package: PKG_ID }, { projection: { operationalStatus: 1, specialty: 1, sessionType: 1 } }).toArray();
console.log('\nDEPOIS:', JSON.stringify(after));
console.log('sessions:', JSON.stringify(afterSess.map((s) => `${s.status}/${s.sessionType}`)));
console.log('appointments:', JSON.stringify(afterAppts.map((a) => `${a.operationalStatus}/${a.specialty}/${a.sessionType}`)));

await mongoose.disconnect();
