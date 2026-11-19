// scripts/isolado/apiFlow.mjs
// Fluxo real do item 7 pela API HTTP do CRM (server.js subido por crmProc.mjs api).
// Dados fictícios. Só fala com o Mongo isolado e com a API em 127.0.0.1.
//
//   node apiFlow.mjs seed            cria admin, profissional e paciente fictícios (idempotente)
//   node apiFlow.mjs post <n> <tag>  POST /api/v2/appointments n vezes (horários distintos)
import { MongoClient } from 'mongodb';
import jwt from 'jsonwebtoken';
import { requireIsolatedMongo, die } from './_guard.mjs';

const { uri, db: dbName } = requireIsolatedMongo();
const port = process.env.CRM_ISOLADO_API_PORT || '5099';
const secret = process.env.CRM_ISOLADO_JWT_SECRET || 'isolado-sem-validade-em-producao';
const [cmd, nRaw, tag = 'x'] = process.argv.slice(2);

const client = await MongoClient.connect(uri, { serverSelectionTimeoutMS: 10_000 });
const db = client.db(dbName);
const FIX = { admin: 'admin@isolado.invalid', doctor: 'profissional@isolado.invalid', patient: 'Paciente Ficticio Isolado' };

try {
  if (cmd === 'seed') {
    await db.collection('admins').updateOne({ email: FIX.admin }, { $setOnInsert: { name: 'Admin Ficticio', email: FIX.admin, role: 'admin' } }, { upsert: true });
    await db.collection('doctors').updateOne({ email: FIX.doctor }, { $setOnInsert: { fullName: 'Profissional Ficticia', email: FIX.doctor, specialty: 'fonoaudiologia', licenseNumber: 'ISOLADO-0001', phoneNumber: '62900000001', active: true } }, { upsert: true });
    await db.collection('patients').updateOne({ fullName: FIX.patient }, { $setOnInsert: { fullName: FIX.patient, dateOfBirth: new Date('2018-01-01'), phone: '62900000002' } }, { upsert: true });
    console.log(JSON.stringify({ msg: 'api_flow_seeded' }));
  } else if (cmd === 'post') {
    const n = Number(nRaw || 1);
    const admin = await db.collection('admins').findOne({ email: FIX.admin });
    const doctor = await db.collection('doctors').findOne({ email: FIX.doctor });
    const patient = await db.collection('patients').findOne({ fullName: FIX.patient });
    if (!admin || !doctor || !patient) die('rode "seed" antes');
    const token = jwt.sign({ id: String(admin._id), _id: String(admin._id), role: 'admin' }, secret, { expiresIn: '10m' });
    const base = await db.collection('appointments').countDocuments({});
    const statuses = [];
    const ids = [];
    for (let i = 0; i < n; i++) {
      const k = base + i; // um horário por agendamento: dia útil distinto, sem conflito
      const day = new Date(Date.UTC(2027, 0, 4 + Math.floor(k / 8) * 7 + (k % 5)));
      const r = await fetch(`http://127.0.0.1:${port}/api/v2/appointments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          patientId: String(patient._id), doctorId: String(doctor._id),
          date: day.toISOString().slice(0, 10), time: `${String(8 + (k % 8)).padStart(2, '0')}:00`,
          specialty: 'fonoaudiologia', serviceType: 'evaluation', billingType: 'particular',
          paymentMethod: 'pix', sessionValue: 220, notes: `isolado ${tag}`
        })
      });
      statuses.push(r.status);
      const body = await r.json().catch(() => ({}));
      if (body?.data?._id) ids.push(body.data._id);
      else console.error(JSON.stringify({ msg: 'api_flow_post_error', status: r.status, code: body?.code || body?.error?.code || null }));
    }
    console.log(JSON.stringify({ msg: 'api_flow_posted', tag, created: ids.length, statuses, ids }));
  } else {
    die('uso: apiFlow.mjs seed | post <n> <tag>');
  }
} finally {
  await client.close();
}
