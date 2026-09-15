import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { writeFile, mkdir } from 'node:fs/promises';
dotenv.config({ path: new URL('../../.env', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), quiet: true });
try {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });
  const db = mongoose.connection.db;
  const rows = await db.collection('appointments').find({ date: { $gte: new Date('2026-09-14T03:00:00Z') }, operationalStatus: 'canceled',
    cancelReason: /^Dia da semana removido da terapia/ }).toArray();
  const results = [];
  for (const row of rows) {
    const plans = await db.collection('therapeuticplans').find({ liminarContract: row.liminarContract, status: 'active' }).toArray();
    const therapy = plans[0]?.therapies?.[row.specialty];
    const day = new Date(row.date).toISOString().slice(0,10);
    const dow = new Date(day+'T12:00:00Z').getUTCDay();
    const matchesSlot = therapy?.slots?.some(s => s.dayOfWeek === dow && s.time === row.time);
    const start = new Date(day+'T00:00:00Z'), end = new Date(start.getTime()+86400000);
    const blocking = await db.collection('appointments').find({ date: { $gte:start, $lt:end }, operationalStatus: { $nin: ['canceled','cancelled','discarded','suspended'] },
      $or: [{ patient:row.patient, specialty:row.specialty }, { doctor:row.doctor, time:row.time }] },
      {projection:{_id:1,time:1,patient:1,specialty:1,operationalStatus:1}}).toArray();
    const sessions = await db.collection('sessions').find({ $or:[{appointmentId:row._id}, {_id:row.session}] },
      {projection:{_id:1,status:1,paymentStatus:1,paymentMethod:1,doctor:1,package:1}}).toArray();
    const payments = await db.collection('payments').find({$or:[{appointment:row._id},{session:{$in:sessions.map(s=>s._id)}}]},
      {projection:{_id:1,status:1,amount:1}}).toArray();
    const patient = await db.collection('patients').findOne({_id:row.patient},{projection:{fullName:1}});
    const contract = await db.collection('liminarcontracts').findOne({_id:row.liminarContract},{projection:{status:1,expirationDate:1}});
    results.push({id:row._id,patient:patient?.fullName,date:day,time:row.time,specialty:row.specialty,billingType:row.billingType,
      contract,plans:plans.map(p=>p._id),matchesSlot:!!matchesSlot,doctorMatches:String(therapy?.doctor)===String(row.doctor),blocking,sessions,payments,
      decision:!matchesSlot?'slot_not_in_current_plan':blocking.length?'existing_attendance_or_conflict':payments.length?'financial_review':sessions.length!==1?'session_link_review':'candidate_for_recovery'});
  }
  await mkdir(new URL('../../auditoria-output/',import.meta.url),{recursive:true});
  await writeFile(new URL('../../auditoria-output/liminar-cancellation-recovery-preview.json',import.meta.url),JSON.stringify(results,null,2));
  console.log(JSON.stringify(results,null,2));
} finally { await mongoose.disconnect(); }
