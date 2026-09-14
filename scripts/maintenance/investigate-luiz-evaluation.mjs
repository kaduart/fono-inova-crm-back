import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config({ path: new URL('../../.env', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), quiet: true });
try {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });
  const db = mongoose.connection.db;
  const patients = await db.collection('patients').find({ fullName: /^Luiz dos Santos Cunha$/i }, { projection: { fullName: 1, patientId: 1 } }).toArray();
  console.log(JSON.stringify({ database: db.databaseName, patients }, null, 2));
  for (const patient of patients) {
    const ids = [patient._id, String(patient._id), ...(patient.patientId ? [patient.patientId] : [])];
    const guides = await db.collection('insuranceguides').find({ patientId: { $in: ids } }, { projection: { number: 1, patientId: 1, specialty: 1, doctorId: 1, issuedAt: 1, createdAt: 1, updatedAt: 1, evaluationAmount: 1, generateEvaluationBilling: 1, evaluationSessionId: 1, status: 1 } }).toArray();
    const appointments = await db.collection('appointments').find({ $or: [{ patient: { $in: ids } }, { insuranceGuide: { $in: guides.map(g => g._id) } }] }, { projection: { patient: 1, doctor: 1, date: 1, time: 1, serviceType: 1, insuranceGuide: 1, insurancePlan: 1, operationalStatus: 1, status: 1, session: 1, payment: 1, billingType: 1, createdAt: 1 } }).sort({ date: -1 }).toArray();
    const evaluations = await db.collection('appointments').find({ patient: patient._id, serviceType: 'evaluation' }).toArray();
    const sessions = await db.collection('sessions').find({ _id: { $in: evaluations.map(a => a.session) } }).toArray();
    const payments = await db.collection('payments').find({ appointment: { $in: evaluations.map(a => a._id) } }).toArray();
    const plans = await db.collection('insuranceplans').find({ patient: patient._id }).toArray();
    console.log(JSON.stringify({ patient: patient.fullName, guides, appointments, evaluations, sessions, payments, plans }, null, 2));
  }
} catch (error) {
  console.error(error.name, String(error.message).replace(/mongodb(?:\+srv)?:\/\/[^\s]+/g, '[connection redacted]'));
  process.exitCode = 1;
} finally { await mongoose.disconnect(); }
