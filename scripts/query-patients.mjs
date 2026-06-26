import 'dotenv/config';
import mongoose from 'mongoose';

await mongoose.connect(process.env.MONGO_URI);
const db = mongoose.connection.db;

// 1. Thayna Miranda - appointments
const thayna = await db.collection('patients').findOne({ name: /thayna miranda/i }, { projection: { _id:1, name:1 } });
console.log('\n=== Thayna Miranda ===');
if (!thayna) { console.log('Paciente não encontrada'); }
else {
  console.log('ID:', thayna._id);
  const apts = await db.collection('appointments').find(
    { patient: thayna._id },
    { projection: { _id:1, date:1, time:1, operationalStatus:1, billingType:1, sessionValue:1, insuranceValue:1, paymentStatus:1, insuranceProvider:1 } }
  ).sort({ date: 1 }).toArray();
  console.log('Appointments:', apts.length);
  apts.forEach(a => console.log(`  ${a.date?.toISOString().slice(0,10)} ${a.time} | ${a.operationalStatus} | ${a.billingType} | sv:${a.sessionValue} iv:${a.insuranceValue} | ps:${a.paymentStatus} | ins:${a.insuranceProvider}`));

  const pkgs = await db.collection('packages').find({ patient: thayna._id }).toArray();
  console.log('\nPackages:', pkgs.length);
  pkgs.forEach(p => console.log(`  [${p._id}] type:${p.type} billingType:${p.billingType} status:${p.financialStatus} sv:${p.sessionValue} total:${p.totalValue}`));
}

// 2. Antonella Sousa Eneas - convenio package
const antonella = await db.collection('patients').findOne({ name: /antonella sousa/i }, { projection: { _id:1, name:1 } });
console.log('\n=== Antonella Sousa Eneas ===');
if (!antonella) { console.log('Paciente não encontrada'); }
else {
  console.log('ID:', antonella._id, '| Nome:', antonella.name);
  const pkgs = await db.collection('packages').find({ patient: antonella._id }).toArray();
  console.log('Packages:', pkgs.length);
  pkgs.forEach(p => console.log(`  [${p._id}] type:${p.type} billingType:${p.billingType} status:${p.financialStatus} totalSessions:${p.totalSessions} done:${p.sessionsDone} remaining:${p.sessionsRemaining} sv:${p.sessionValue}`));

  const apts = await db.collection('appointments').find(
    { patient: antonella._id },
    { projection: { _id:1, date:1, time:1, operationalStatus:1, billingType:1, sessionValue:1, insuranceValue:1, paymentStatus:1, insuranceProvider:1 } }
  ).sort({ date: 1 }).toArray();
  console.log('\nAppointments:', apts.length);
  apts.forEach(a => console.log(`  ${a.date?.toISOString().slice(0,10)} ${a.time} | ${a.operationalStatus} | ${a.billingType} | sv:${a.sessionValue} iv:${a.insuranceValue} | ps:${a.paymentStatus} | ins:${a.insuranceProvider}`));
}

await mongoose.disconnect();
