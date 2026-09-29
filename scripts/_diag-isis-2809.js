#!/usr/bin/env node
// SOMENTE LEITURA — diagnóstico pendente×recebido Isis 28/09/2026
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });
const { ObjectId } = mongoose.Types;
const j = o => JSON.stringify(o, null, 1);
await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
const db = mongoose.connection.db;
const APPT = new ObjectId('6aa150d37d4ff22a69deb71f');
const PAY = new ObjectId('6abab9d07e9298d6a27d6d20');
const PKG_A = new ObjectId('6aa150d27d4ff22a69deb708');
const PKG_B = new ObjectId('6a746daaf69cb76a5e463a38');
const PAT = new ObjectId('685b0cfaaec14c7163585b5b');

const appt = await db.collection('appointments').findOne({ _id: APPT });
console.log('=== APPOINTMENT ===\n', j(appt));
const pay = await db.collection('payments').findOne({ _id: PAY });
console.log('=== PAYMENT recebido ===\n', j(pay));
if (appt?.session) console.log('=== SESSION ===\n', j(await db.collection('sessions').findOne({ _id: appt.session })));
console.log('=== PAYMENTS ligados ao appointment/session ===');
for (const p of await db.collection('payments').find({ $or: [{ appointment: APPT }, { appointmentId: APPT }, ...(appt?.session ? [{ session: appt.session }] : [])] }).toArray())
  console.log(p._id, p.kind, p.status, p.amount, p.paymentMethod, p.package, p.paymentDate, p.serviceDate, p.createdAt);
for (const [n, id] of [['PKG_A (do appt)', PKG_A], ['PKG_B (do payment)', PKG_B]]) {
  const k = await db.collection('packages').findOne({ _id: id }, { projection: { sessions: 0, appointments: 0, payments: 0 } });
  console.log(`=== ${n} ===\n`, j(k));
}
console.log('=== Todos payments Isis 2026-09-20..30 ===');
const from = new Date('2026-09-20'), to = new Date('2026-10-01');
for (const p of await db.collection('payments').find({ patient: PAT, $or: [{ paymentDate: { $gte: from, $lt: to } }, { createdAt: { $gte: from, $lt: to } }, { serviceDate: { $gte: from, $lt: to } }] }).sort({ createdAt: 1 }).toArray())
  console.log(p._id, p.kind, p.status, p.amount, p.paymentMethod, 'pkg', p.package, 'appt', p.appointment, 'sess', p.session, 'pd', p.paymentDate, 'sd', p.serviceDate, 'ca', p.createdAt);
console.log('=== Appointments Isis 2026-09-20..30 ===');
for (const a of await db.collection('appointments').find({ patient: PAT, date: { $gte: from, $lt: to } }).sort({ date: 1 }).toArray())
  console.log(a._id, a.date, a.time, a.specialty, a.operationalStatus || a.status, a.paymentStatus, 'pkg', a.package, 'pay', a.payment, 'sess', a.session);
process.exit(0);
