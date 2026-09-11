#!/usr/bin/env node

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(scriptDir, '../../.env') });

const APPOINTMENT_ID = new mongoose.Types.ObjectId('6aa443863f4b9436770b748d');
const GUIDE_IDS = [
  new mongoose.Types.ObjectId('6a455d86494b0ecabb70dac7'),
  new mongoose.Types.ObjectId('6a7e12c32f206c445bc95c52'),
];

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const appointment = await db.collection('appointments').findOne({ _id: APPOINTMENT_ID });
  const sessions = await db.collection('sessions').find({
    $or: [{ appointmentId: APPOINTMENT_ID }, { appointment: APPOINTMENT_ID }],
  }).toArray();
  const payments = await db.collection('payments').find({ appointment: APPOINTMENT_ID }).toArray();
  const guides = await db.collection('insuranceguides').find({ _id: { $in: GUIDE_IDS } }).toArray();
  const ledger = await db.collection('financial_ledger').find({
    $or: [{ appointment: APPOINTMENT_ID }, { appointmentId: APPOINTMENT_ID }],
  }).toArray();

  console.log(JSON.stringify({
    appointment: appointment && {
      _id: appointment._id,
      insuranceGuide: appointment.insuranceGuide,
      insurancePlan: appointment.insurancePlan,
      operationalStatus: appointment.operationalStatus,
      payment: appointment.payment,
    },
    sessions: sessions.map(session => ({
      _id: session._id,
      status: session.status,
      insuranceGuide: session.insuranceGuide,
      guideConsumed: session.guideConsumed,
      guideConsumedAt: session.guideConsumedAt,
      paymentId: session.paymentId,
      date: session.date,
      time: session.time,
    })),
    payments: payments.map(payment => ({
      _id: payment._id,
      status: payment.status,
      amount: payment.amount,
      insuranceGuide: payment.insuranceGuide,
      insurancePlan: payment.insurancePlan,
      insurance: payment.insurance,
    })),
    guides: guides.map(guide => ({
      _id: guide._id,
      number: guide.number,
      status: guide.status,
      usedSessions: guide.usedSessions,
      totalSessions: guide.totalSessions,
      startsAt: guide.startsAt,
      validFrom: guide.validFrom,
      expiresAt: guide.expiresAt,
      insurancePlan: guide.insurancePlan,
      consumptionHistory: (guide.consumptionHistory || []).slice(-5),
    })),
    ledger: ledger.map(entry => ({
      _id: entry._id,
      type: entry.type,
      amount: entry.amount,
      value: entry.value,
      status: entry.status,
      reversedAt: entry.reversedAt,
      referenceId: entry.referenceId,
      session: entry.session,
      sessionId: entry.sessionId,
      payment: entry.payment,
      paymentId: entry.paymentId,
    })),
  }, null, 2));
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
