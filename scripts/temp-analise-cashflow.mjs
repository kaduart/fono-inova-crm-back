import 'dotenv/config';
import { MongoClient } from 'mongodb';

const client = new MongoClient(process.env.MONGO_URI);
await client.connect();
const db = client.db();

const start = new Date('2026-07-03T00:00:00.000Z');
const end = new Date('2026-07-03T23:59:59.999Z');

console.log('=== APPOINTMENTS COMPLETED HOJE ===');
const completed = await db.collection('appointments').find({
  date: { $gte: start, $lte: end },
  operationalStatus: 'completed'
}, {
  projection: { date: 1, time: 1, patient: 1, doctor: 1, specialty: 1, billingType: 1, paymentMethod: 1, sessionValue: 1, paymentStatus: 1, package: 1, insuranceGuide: 1, completedAt: 1 }
}).sort({ time: 1 }).toArray();

const patients = await db.collection('patients').find({}, { projection: { fullName: 1 } }).toArray();
const patientMap = new Map(patients.map(p => [p._id.toString(), p.fullName]));

const enrichedCompleted = completed.map(a => ({
  ...a,
  patientName: patientMap.get(a.patient?.toString()) || a.patient?.toString()
}));
console.log(JSON.stringify(enrichedCompleted, null, 2));
console.log('Total completed:', completed.length);

console.log('\n=== APPOINTMENTS CONFIRMED HOJE ===');
const confirmed = await db.collection('appointments').find({
  date: { $gte: start, $lte: end },
  operationalStatus: 'confirmed'
}, {
  projection: { date: 1, time: 1, patient: 1, doctor: 1, specialty: 1, billingType: 1, paymentMethod: 1, sessionValue: 1, paymentStatus: 1, package: 1, insuranceGuide: 1 }
}).sort({ time: 1 }).toArray();

const enrichedConfirmed = confirmed.map(a => ({
  ...a,
  patientName: patientMap.get(a.patient?.toString()) || a.patient?.toString()
}));
console.log(JSON.stringify(enrichedConfirmed, null, 2));
console.log('Total confirmed:', confirmed.length);

await client.close();
