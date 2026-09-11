#!/usr/bin/env node

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(scriptDir, '../../.env') });

const conflictSessionIds = [
  '6a7ce133d01df3056ebaea35',
  '6a7ce133d01df3056ebaea34',
  '6a7ce133d01df3056ebaea37',
  '6a7ce133d01df3056ebaea36',
  '6a7ce133d01df3056ebaea38',
  '6a4576de02c3c83ca19de717',
  '6a4576de02c3c83ca19de718',
  '6a4576de02c3c83ca19de71a',
  '6a1dc2eb4bafb710ab1610ad',
  '6a1dc25d4bafb710ab160f45',
  '6a1dc25d4bafb710ab160f43',
  '6a1dc25d4bafb710ab160f42',
  '6a1dc25d4bafb710ab160f40',
  '69d67dfe19c6571d8c76dbc5',
  '69d646e885f1fc2849c5b662',
  '6a0c540580cc438aa0b67d3c',
].map(id => new mongoose.Types.ObjectId(id));

function uniqueObjectIds(values) {
  return [...new Map(values.filter(Boolean).map(value => [String(value), value])).values()];
}

async function main() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) throw new Error('MONGO_URI não configurado');

  await mongoose.connect(mongoUri, { maxPoolSize: 5, serverSelectionTimeoutMS: 30_000 });
  const db = mongoose.connection.db;

  const sessions = await db.collection('sessions')
    .find({ _id: { $in: conflictSessionIds } })
    .sort({ date: 1 })
    .toArray();

  const appointmentIds = uniqueObjectIds(sessions.map(session => session.appointmentId));
  const appointments = await db.collection('appointments').find({
    $or: [
      { _id: { $in: appointmentIds } },
      { session: { $in: conflictSessionIds } },
    ],
  }).toArray();
  const allAppointmentIds = uniqueObjectIds(appointments.map(appointment => appointment._id));

  const payments = await db.collection('payments').find({
    $or: [
      { session: { $in: conflictSessionIds } },
      { appointment: { $in: allAppointmentIds } },
    ],
  }).sort({ createdAt: 1 }).toArray();

  const guideIds = uniqueObjectIds(sessions.map(session => session.insuranceGuide));
  const guides = await db.collection('insuranceguides')
    .find({ _id: { $in: guideIds } })
    .toArray();

  const appointmentById = new Map(appointments.map(appointment => [String(appointment._id), appointment]));
  const guideById = new Map(guides.map(guide => [String(guide._id), guide]));
  const paymentsBySession = new Map();
  for (const payment of payments) {
    const key = String(payment.session || '');
    if (!paymentsBySession.has(key)) paymentsBySession.set(key, []);
    paymentsBySession.get(key).push(payment);
  }

  const report = sessions.map(session => {
    const appointment = appointmentById.get(String(session.appointmentId))
      || appointments.find(item => String(item.session) === String(session._id));
    const guide = guideById.get(String(session.insuranceGuide));

    return {
      sessionId: String(session._id),
      date: session.date,
      time: session.time,
      status: session.status,
      value: session.sessionValue,
      guideConsumed: session.guideConsumed,
      paymentId: session.paymentId ? String(session.paymentId) : null,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      notes: session.notes,
      appointment: appointment ? {
        id: String(appointment._id),
        time: appointment.time,
        status: appointment.operationalStatus,
        clinicalStatus: appointment.clinicalStatus,
        paymentStatus: appointment.paymentStatus,
        payment: appointment.payment ? String(appointment.payment) : null,
        billingType: appointment.billingType,
        paymentMethod: appointment.paymentMethod,
        cancelReason: appointment.cancelReason,
        createdAt: appointment.createdAt,
        updatedAt: appointment.updatedAt,
        history: (appointment.history || []).slice(-3),
      } : null,
      guide: guide ? {
        id: String(guide._id),
        number: guide.number,
        status: guide.status,
        usedSessions: guide.usedSessions,
        totalSessions: guide.totalSessions,
        sessionValue: guide.sessionValue,
        consumptionEntries: (guide.consumptionHistory || [])
          .filter(entry => String(entry.sessionId) === String(session._id)).length,
      } : null,
      payments: (paymentsBySession.get(String(session._id)) || []).map(payment => ({
        id: String(payment._id),
        status: payment.status,
        amount: payment.amount,
        kind: payment.kind,
        paymentMethod: payment.paymentMethod,
        billingType: payment.billingType,
        serviceDate: payment.serviceDate,
        insurance: payment.insurance,
        canceledReason: payment.canceledReason,
        notes: payment.notes,
        source: payment.source,
        createdAt: payment.createdAt,
        updatedAt: payment.updatedAt,
      })),
    };
  });

  console.log(JSON.stringify({ expected: conflictSessionIds.length, found: report.length, sessions: report }, null, 2));
  await mongoose.disconnect();
}

main().catch(async error => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
