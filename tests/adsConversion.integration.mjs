// tests/adsConversion.integration.mjs
// Integração do CRON REAL + models REAIS contra um mongod REAL. Fronteiras (Meta/TikTok/
// Google/atribuição) simuladas via loader tests/adsConversion.cron.boundaries.mjs.
// NÃO usa motor de Mongo simulado. Depende de SERVIDOR REAL — pula se ausente.
//
// Rodar:
//   npm i
//   MONGO_TEST_URI="mongodb://localhost:27017/adsint_test" \
//     node --import ./tests/adsConversion.cron.boundaries.mjs tests/adsConversion.integration.mjs
//
// Cobre (depende de servidor): criação efetiva do índice parcial único + E11000;
// aquisição com original cancelado/inelegível nunca enviado (#1); reserva ATÔMICA do
// pendente sob concorrência com event_id estável (#3).
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

const URI = process.env.MONGO_TEST_URI;
if (!URI) {
  console.log('SKIP (depende de servidor real): defina MONGO_TEST_URI apontando p/ um mongod real.');
  process.exit(0);
}

let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; console.log('  ✓', n); } catch (e) { fail++; console.log('  ✗', n, '\n      ', e.message); } };
const oid = () => new mongoose.Types.ObjectId();
const DAY = 864e5, now = Date.now();

await mongoose.connect(URI);
const AdConversion = (await import('../models/AdConversion.js')).default;
const Appointment = (await import('../models/Appointment.js')).default;
const Patient = (await import('../models/Patient.js')).default;
const { enqueueNew, processPending } = await import('../crons/adsConversion.cron.js');

await AdConversion.collection.deleteMany({});
await AdConversion.syncIndexes(); // CRIA de fato o índice parcial único no servidor

await t('#0 índice parcial único criado no servidor', async () => {
  const idx = await AdConversion.collection.indexes();
  const u = idx.find((i) => i.name === 'uniq_acquisition_per_patient');
  assert.ok(u, 'índice não existe no servidor'); assert.equal(u.unique, true);
  assert.deepEqual(u.partialFilterExpression, { patient: { $type: 'objectId' }, isAcquisition: true });
});

await t('#0 E11000: 2ª aquisição do mesmo paciente é rejeitada pelo servidor', async () => {
  const P = oid();
  const base = { patient: P, isAcquisition: true, phone: '5562992013573', value: 220, eventTime: new Date(), meta: { status: 'pending' } };
  await AdConversion.create({ ...base, appointment: oid() });
  await assert.rejects(AdConversion.create({ ...base, appointment: oid() }), (e) => e.code === 11000);
});

await t('#1 original cancelado/inelegível nunca enviado + novo válido -> 1 aquisição no novo', async () => {
  await AdConversion.collection.deleteMany({}); await Appointment.collection.deleteMany({});
  const P = oid();
  await Patient.create({ _id: P, phone: '62992013573', fullName: 'Teste' });
  const A1 = await Appointment.create({ _id: oid(), patient: P, operationalStatus: 'canceled', date: new Date(), createdAt: new Date(now - 5*DAY) });
  const A2 = await Appointment.create({ _id: oid(), patient: P, operationalStatus: 'scheduled', date: new Date(), createdAt: new Date(now - 1*DAY) });
  globalThis.__ATTR__ = { '5562992013573': { source: 'meta', method: 'token' } };
  await enqueueNew();
  const acq = await AdConversion.find({ patient: P, isAcquisition: true });
  assert.equal(acq.length, 1, 'deve haver 1 aquisição mesmo com original cancelado');
  assert.equal(String(acq[0].appointment), String(A2._id), 'aquisição recai no agendamento válido');
});

await t('#3 reserva ATÔMICA: 2 processPending concorrentes -> 1 envio, event_id estável', async () => {
  await AdConversion.collection.deleteMany({});
  const appt = oid();
  await AdConversion.create({ appointment: appt, patient: oid(), isAcquisition: true, phone: '5562992013573',
    value: 220, eventTime: new Date(), fbc: null, meta: { status: 'pending' }, google: { status: 'skipped', reason: 'sem_gclid' }, tiktok: { status: 'skipped', reason: 'sem_identificador' }, done: false, nextAttemptAt: new Date(now - 1000) });
  const calls = [];
  globalThis.__META__ = async (d) => { calls.push(d.eventId); await new Promise(r => setTimeout(r, 50)); return { events_received: 1, fbtrace_id: 'tr' }; };
  await Promise.all([processPending(), processPending()]);
  assert.equal(calls.length, 1, 'apenas um worker envia (reserva atômica)');
  assert.equal(calls[0], `appt_${appt}`, 'event_id estável por agendamento');
  const row = await AdConversion.findOne({ appointment: appt });
  assert.equal(row.meta.status, 'sent');
});

console.log(`\n==== ${pass} passaram, ${fail} falharam ====`);
await mongoose.disconnect();
process.exit(fail ? 1 : 0);
