// Apoio de scripts/backup/validar-restauracao-ficticia.sh.
//   seed   <uri> <db>          cria dados FICTÍCIOS + índices
//   digest <uri> <db> <saida>  grava contagem, hash do conteúdo e índices por coleção
//   compare <a.json> <b.json>  compara dois digests
// Só aceita Mongo em loopback.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { MongoClient, ObjectId, Decimal128 } from 'mongodb';
import { EJSON } from 'bson';

const [mode, a, b, c] = process.argv.slice(2);
const loopback = (u) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(u).hostname);

async function withDb(uri, db, fn) {
  if (!loopback(uri)) throw new Error('só Mongo em loopback');
  const cli = new MongoClient(uri);
  await cli.connect();
  try { return await fn(cli.db(db)); } finally { await cli.close(); }
}

const oid = (n) => new ObjectId(n.toString(16).padStart(24, '0'));
const day = (i) => new Date(Date.UTC(2026, 0, 1 + (i % 300), 12, 0, 0));

async function seed(uri, dbName) {
  await withDb(uri, dbName, async (db) => {
    const N = 500;
    const patients = Array.from({ length: N }, (_, i) => ({
      _id: oid(1_000 + i), fullName: `Paciente Fictício ${i}`, phone: `55629000${String(i).padStart(5, '0')}`,
      birthDate: day(i), tags: i % 3 ? ['fono'] : ['psico', 'to'], createdAt: day(i)
    }));
    const appointments = Array.from({ length: N * 3 }, (_, i) => ({
      _id: oid(100_000 + i), patient: oid(1_000 + (i % N)), date: day(i), status: ['scheduled', 'confirmed', 'canceled'][i % 3],
      value: Decimal128.fromString(`${180 + (i % 5) * 10}.00`)
    }));
    const payments = Array.from({ length: N * 2 }, (_, i) => ({
      _id: oid(200_000 + i), patient: oid(1_000 + (i % N)), amount: 220, paymentMethod: ['pix', 'cartao', 'dinheiro'][i % 3],
      status: 'paid', paidAt: day(i), notes: i % 50 === 0 ? 'acentuação: ção ã é ü 💚' : null
    }));
    const ops = Array.from({ length: 50 }, (_, i) => ({ _id: `payop:teste:${i}`, kind: 'standalone', patient: oid(1_000 + i), appliedAt: day(i), result: { ok: true } }));
    const deliveries = Array.from({ length: 50 }, (_, i) => ({ _id: `wa:send:teste:${i}`, channel: 'whatsapp', status: i % 10 ? 'sent' : 'unknown', createdAt: day(i) }));
    await db.collection('patients').insertMany(patients);
    await db.collection('appointments').insertMany(appointments);
    await db.collection('payments').insertMany(payments);
    await db.collection('payment_operations').insertMany(ops);
    await db.collection('outbound_deliveries').insertMany(deliveries);
    await db.collection('patients').createIndex({ phone: 1 }, { unique: true });
    await db.collection('appointments').createIndex({ patient: 1, date: -1 });
    await db.collection('payment_operations').createIndex({ patient: 1, appliedAt: -1 });
    await db.collection('outbound_deliveries').createIndex({ status: 1, createdAt: 1 }, { name: 'status_createdAt' });
    console.log(`dados fictícios: ${patients.length} pacientes, ${appointments.length} agendamentos, ${payments.length} pagamentos, ${ops.length} operações, ${deliveries.length} entregas`);
  });
}

async function digest(uri, dbName, out) {
  const res = await withDb(uri, dbName, async (db) => {
    const r = {};
    const colls = (await db.listCollections({}, { nameOnly: true }).toArray()).map(x => x.name).filter(n => !n.startsWith('system.')).sort();
    for (const name of colls) {
      const h = crypto.createHash('sha256');
      let count = 0;
      for await (const d of db.collection(name).find({}).sort({ _id: 1 })) { h.update(EJSON.stringify(d, { relaxed: false })); count++; }
      const idx = (await db.collection(name).indexes()).map(({ v, ns, ...rest }) => rest).sort((x, y) => x.name.localeCompare(y.name));
      r[name] = { count, sha256: h.digest('hex'), indexes: idx };
    }
    return r;
  });
  fs.writeFileSync(out, JSON.stringify(res, null, 2));
  for (const [n, v] of Object.entries(res)) console.log(`${n}: ${v.count} docs, ${v.indexes.length} índices, ${v.sha256.slice(0, 12)}`);
}

function compare(fa, fb) {
  const A = JSON.parse(fs.readFileSync(fa, 'utf8')), B = JSON.parse(fs.readFileSync(fb, 'utf8'));
  const diffs = [];
  for (const n of new Set([...Object.keys(A), ...Object.keys(B)])) {
    if (!A[n] || !B[n]) { diffs.push(`${n}: existe só em ${A[n] ? 'origem' : 'destino'}`); continue; }
    if (A[n].count !== B[n].count) diffs.push(`${n}: contagem ${A[n].count} != ${B[n].count}`);
    if (A[n].sha256 !== B[n].sha256) diffs.push(`${n}: conteúdo diferente`);
    if (JSON.stringify(A[n].indexes) !== JSON.stringify(B[n].indexes)) diffs.push(`${n}: índices diferentes`);
  }
  if (diffs.length) { console.error(diffs.join('\n')); process.exit(1); }
  console.log(`idêntico: ${Object.keys(A).length} coleções (contagem, conteúdo e índices)`);
}

if (mode === 'seed') await seed(a, b);
else if (mode === 'digest') await digest(a, b, c);
else if (mode === 'compare') compare(a, b);
else { console.error('uso: seed|digest|compare'); process.exit(2); }
