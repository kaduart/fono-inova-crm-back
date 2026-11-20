// Reentrega dos destinos de projeção (patient-projection, package-projection): o resultado
// depende só do banco atual, então 1, 3 ou 6 entregas (em sequência ou ao mesmo tempo) dão a
// mesma visão. É a prova usada para classificar esses tipos como idempotentes na tabela de
// validade do Outbox. Mongo e Redis DESCARTÁVEIS em loopback, dados fictícios.
//   MONGO_TXN_TEST_URI='mongodb://127.0.0.1:27217/?directConnection=true' REDIS_URL=redis://127.0.0.1:6479 \
//     node --test --test-force-exit --test-concurrency=1 tests/recovery/projectionReplay.mongo.nodetest.mjs
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

const URI = process.env.MONGO_TXN_TEST_URI;
const skip = !URI ? 'MONGO_TXN_TEST_URI não definido' : false;
const loop = (u) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(u).hostname);
if (URI && !loop(URI)) throw new Error('MONGO_TXN_TEST_URI precisa ser loopback');
if (process.env.REDIS_URL && !loop(process.env.REDIS_URL)) throw new Error('REDIS_URL precisa ser loopback');

const oid = () => new mongoose.Types.ObjectId();
let buildPatientView, buildPackageView, PatientsView, PackagesView, Patient, Appointment, Payment, Package, Session;

// Tira o que muda a cada reconstrução (relógio e o _id que o Mongoose gera para subdocumentos),
// compara o resto.
const VOLATEIS = new Set(['updatedAt', 'createdAt', 'lastRebuiltAt', 'lastBuiltAt', 'snapshot', 'builtAt', 'rebuiltAt', 'lastUpdated', 'lastSyncedAt', '__v', 'version', 'correlationId']);
const limpa = (v, fundo = 0) => {
  if (Array.isArray(v)) return v.map(x => limpa(x, fundo));
  if (v && typeof v === 'object' && !(v instanceof Date) && !(v instanceof mongoose.Types.ObjectId)) {
    return Object.fromEntries(Object.entries(v).filter(([k]) => !VOLATEIS.has(k) && !(k === '_id' && fundo > 0)).map(([k, x]) => [k, limpa(x, fundo + 1)]));
  }
  return v instanceof mongoose.Types.ObjectId ? String(v) : v;
};

before(async () => {
  if (skip) return;
  await mongoose.connect(URI, { dbName: `crm_replay_proj_${Date.now()}` });
  ({ buildPatientView } = await import('../../domains/clinical/services/patientProjectionService.js'));
  ({ buildPackageView } = await import('../../domains/billing/services/PackageProjectionService.js'));
  ({ default: Patient } = await import('../../models/Patient.js'));
  ({ default: Appointment } = await import('../../models/Appointment.js'));
  ({ default: Payment } = await import('../../models/Payment.js'));
  ({ default: Package } = await import('../../models/Package.js'));
  ({ default: Session } = await import('../../models/Session.js'));
  PatientsView = mongoose.connection.collection('patients_view');
  for (const M of [Patient, Appointment, Payment, Package, Session]) await M.createCollection().catch(() => {});
});

after(async () => {
  if (skip) return;
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
});

async function fixture() {
  const patient = oid(), doctor = oid(), pkg = oid();
  await Patient.collection.insertOne({ _id: patient, fullName: 'Paciente Fictício', dateOfBirth: new Date('2018-01-01'), phone: '0000000000', isActive: true, createdAt: new Date() });
  const appts = [0, 1, 2].map(i => ({ _id: oid(), patient, doctor, date: `2026-11-1${i}`, time: '10:00', operationalStatus: i === 2 ? 'canceled' : 'completed', clinicalStatus: 'completed', serviceType: 'session', specialty: 'fonoaudiologia', sessionValue: 180, paymentStatus: 'paid', package: pkg }));
  await Appointment.collection.insertMany(appts);
  await Payment.collection.insertMany(appts.slice(0, 2).map(a => ({ _id: oid(), patient, patientId: patient, appointment: a._id, amount: 180, status: 'paid', billingType: 'particular', kind: 'session_payment', paymentDate: a.date, createdAt: new Date() })));
  await Package.collection.insertOne({ _id: pkg, patient, doctor, totalSessions: 4, sessionsDone: 2, sessionValue: 180, totalValue: 720, totalPaid: 360, balance: 360, financialStatus: 'partially_paid', status: 'active', specialty: 'fonoaudiologia', sessionType: 'fonoaudiologia', type: 'therapy', model: 'per_session', createdAt: new Date() });
  return { patient: String(patient), pkg: String(pkg) };
}

describe('patient-projection (buildPatientView)', () => {
  test('1, 3 e 6 entregas, em sequência e simultâneas, dão a mesma visão', { skip }, async () => {
    const { patient } = await fixture();
    await buildPatientView(patient, { correlationId: 'r1' });
    const uma = limpa(await PatientsView.findOne({}));
    assert.ok(uma, 'visão não foi criada');
    for (let i = 0; i < 2; i++) await buildPatientView(patient, { correlationId: 'seq' });
    assert.deepEqual(limpa(await PatientsView.findOne({})), uma);
    await Promise.allSettled(Array.from({ length: 6 }, () => buildPatientView(patient, { correlationId: 'par' })));
    assert.equal(await PatientsView.countDocuments({}), 1);
    assert.deepEqual(limpa(await PatientsView.findOne({})), uma);
  });
});

describe('package-projection (buildPackageView)', () => {
  test('repetir a reconstrução do pacote não muda a visão', { skip }, async () => {
    const { pkg } = await fixture();
    await buildPackageView(pkg, { correlationId: 'r1' });
    PackagesView = mongoose.connection.collection('packages_view');
    const filtro = { packageId: new mongoose.Types.ObjectId(pkg) };
    const uma = limpa(await PackagesView.find(filtro).toArray());
    assert.ok(uma.length >= 1);
    for (let i = 0; i < 2; i++) await buildPackageView(pkg, { correlationId: 'seq' });
    await Promise.allSettled(Array.from({ length: 6 }, () => buildPackageView(pkg, { correlationId: 'par' })));
    assert.deepEqual(limpa(await PackagesView.find(filtro).toArray()), uma);
  });
});
