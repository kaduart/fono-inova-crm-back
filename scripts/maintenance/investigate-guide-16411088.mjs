#!/usr/bin/env node
// Read-only investigation — no writes. Guia #16411088 (paciente do print no chat com o comercial).
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import moment from 'moment-timezone';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../../.env') });
dotenv.config();

import '../../models/index.js';
import Appointment from '../../models/Appointment.js';
import Session from '../../models/Session.js';
import Payment from '../../models/Payment.js';
import InsuranceGuide from '../../models/InsuranceGuide.js';
import InsurancePlan from '../../models/InsurancePlan.js';

const TZ = 'America/Sao_Paulo';
const GUIDE_ID = '6a5a2dc5ce43485b2af4c307';
const PLAN_ID = '6a5a2df0ce43485b2af4c333';
const d10 = (d) => moment.tz(d, TZ).format('YYYY-MM-DD (ddd)');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const guide = await InsuranceGuide.findById(GUIDE_ID).lean();
  const plan = await InsurancePlan.findById(PLAN_ID).lean();
  const appts = await Appointment.find({ insurancePlan: PLAN_ID }).sort({ date: 1, time: 1 }).lean();

  console.log('═'.repeat(90));
  console.log(`GUIA #${guide?.number} · ${guide?.insurance} · ${guide?.specialty} · usedSessions ${guide?.usedSessions}/${guide?.totalSessions}`);
  console.log(`consumptionHistory: ${(guide?.consumptionHistory || []).length} entradas`);
  console.log(`PLANO: startDate=${plan?.startDate} sessionsPerWeek=${plan?.sessionsPerWeek} slots=${JSON.stringify(plan?.slots)}`);
  console.log('═'.repeat(90));

  for (const a of appts) {
    const sessions = await Session.find({ $or: [{ appointmentId: a._id }, { appointment: a._id }] }).lean();
    const payments = await Payment.find({ appointment: a._id }).lean();
    console.log(`\n${d10(a.date)} ${a.time}  status=${a.operationalStatus}  id=${a._id}`);
    for (const s of sessions) {
      const inHistory = (guide.consumptionHistory || []).some(h => String(h.sessionId) === String(s._id));
      console.log(`   Session ${s._id} status=${s.status} guideConsumed=${s.guideConsumed} inConsumptionHistory=${inHistory}`);
    }
    for (const p of payments) {
      console.log(`   Payment ${p._id} status=${p.status} kind=${p.kind} amount=${p.amount} insurance.status=${p.insurance?.status} batchId=${p.insurance?.batchId}`);
    }
  }

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
