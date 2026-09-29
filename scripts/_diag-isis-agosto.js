#!/usr/bin/env node
// SOMENTE LEITURA — sessões fono Isis agosto/2026
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });
const { ObjectId } = mongoose.Types;
await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
const db = mongoose.connection.db;
const PAT = new ObjectId('685b0cfaaec14c7163585b5b');
const from = new Date('2026-08-01'), to = new Date('2026-09-12');
const appts = await db.collection('appointments').find({ patient: PAT, specialty: 'fonoaudiologia', date: { $gte: from, $lt: to } }).sort({ date: 1 }).toArray();
for (const a of appts) {
  const s = a.session ? await db.collection('sessions').findOne({ _id: a.session }) : null;
  console.log(`\nAPPT ${a._id} ${a.date.toISOString()} ${a.operationalStatus}/${a.clinicalStatus} pay:${a.paymentStatus} pkg:${a.package}`);
  if (s) console.log(`  SESS ${s._id} status:${s.status} isPaid:${s.isPaid} paymentStatus:${s.paymentStatus} visual:${s.visualFlag} pkg:${s.package} paymentId:${s.paymentId}`);
  const pays = await db.collection('payments').find({ $or: [{ appointment: a._id }, ...(a.session ? [{ session: a.session }, { sessions: a.session }] : [])] }).toArray();
  for (const p of pays) console.log(`  PAY ${p._id} ${p.kind} ${p.status} ${p.amount} ${p.paymentMethod} paidAt:${p.paidAt?.toISOString?.()} created:${p.createdAt?.toISOString?.()} by:${p.createdBy} notes:${p.notes}`);
}
process.exit(0);
