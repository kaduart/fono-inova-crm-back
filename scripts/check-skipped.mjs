import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';

const client = new MongoClient(process.env.MONGO_URI);
await client.connect();
const db = client.db();

const ids = [
  '6a28251e81f5401cd57e9321',
  '6a28260f81f5401cd57e934d',
  '6a28264081f5401cd57e9358',
  '6a28267281f5401cd57e9363',
  '6a3c10d1bbd6959696d27799',
  '6a3c10d1bbd6959696d2779a',
].map(id => new ObjectId(id));

const apts = await db.collection('appointments').find(
  { _id: { $in: ids } },
  { projection: { _id:1, date:1, patient:1, insuranceProvider:1, insuranceGuide:1, sessionValue:1, insuranceValue:1, operationalStatus:1 } }
).toArray();

// busca nomes dos pacientes
const patIds = [...new Set(apts.map(a => a.patient))].filter(Boolean);
const patients = await db.collection('patients').find({ _id: { $in: patIds } }, { projection: { fullName:1 } }).toArray();
const nameMap = Object.fromEntries(patients.map(p => [p._id.toString(), p.fullName]));

// busca guides
const guideIds = apts.map(a => a.insuranceGuide).filter(Boolean);
const guides = await db.collection('insuranceguides').find({ _id: { $in: guideIds } }, { projection: { _id:1, sessionValue:1, insurance:1 } }).toArray();
const guideMap = Object.fromEntries(guides.map(g => [g._id.toString(), g]));

for (const a of apts) {
  const guide = a.insuranceGuide ? guideMap[a.insuranceGuide.toString()] : null;
  console.log(`[${a._id}]`);
  console.log(`  Paciente: ${nameMap[a.patient?.toString()] || a.patient}`);
  console.log(`  Date: ${a.date?.toISOString().slice(0,10)} | Status: ${a.operationalStatus}`);
  console.log(`  Provider: ${a.insuranceProvider} | sv:${a.sessionValue} iv:${a.insuranceValue}`);
  console.log(`  Guide: ${a.insuranceGuide || 'NENHUM'} | guide.sessionValue: ${guide?.sessionValue ?? 'N/A'}`);
}

await client.close();
