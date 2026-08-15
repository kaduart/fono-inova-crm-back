// SOMENTE LEITURA
import 'dotenv/config';
import mongoose from 'mongoose';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  const guide = await db.collection('insuranceguides').findOne({ _id: new mongoose.Types.ObjectId('6a7e12c32f206c445bc95c52') });
  console.log('=== GUIDE 16173376 ===');
  console.log(JSON.stringify({ status: guide.status, usedSessions: guide.usedSessions, totalSessions: guide.totalSessions, consumptionHistory: guide.consumptionHistory }, null, 2));

  const appts = await db.collection('appointments').find({ insurancePlan: new mongoose.Types.ObjectId('6a7e13692f206c445bc95ea4') }).sort({ date: 1 }).toArray();
  console.log(`\n=== APPOINTMENTS DO PLANO (${appts.length}) ===`);
  for (const a of appts) {
    console.log(a._id.toString(), a.date.toISOString().split('T')[0], a.time, a.operationalStatus, 'createdAt=' + a.createdAt?.toISOString(), 'completedAt=' + a.completedAt);
  }

  const sessions = await db.collection('sessions').find({ insuranceGuide: guide._id }).sort({ date: 1 }).toArray();
  console.log(`\n=== SESSIONS DA GUIA (${sessions.length}) ===`);
  for (const s of sessions) {
    console.log(s._id.toString(), s.date?.toISOString().split('T')[0], s.time, s.status, 'createdAt=' + s.createdAt?.toISOString());
  }

  const payments = await db.collection('payments').find({ insuranceGuide: guide._id }).sort({ paymentDate: 1 }).toArray();
  console.log(`\n=== PAYMENTS DA GUIA (${payments.length}) ===`);
  for (const p of payments) {
    console.log(p._id.toString(), p.paymentDate?.toISOString().split('T')[0], p.status, p.insurance?.status, 'createdAt=' + p.createdAt?.toISOString());
  }

  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
