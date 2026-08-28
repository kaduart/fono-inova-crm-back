import 'dotenv/config';
import mongoose from 'mongoose';
import Payment from '../models/Payment.js';
import Appointment from '../models/Appointment.js';

const IDS = [
  "6a5e719dce43485b2af53897","6a5e71cfce43485b2af53979","6a67bac5ba74694dae1b4ab3",
  "6a67c4a3ba74694dae1b522d","6a70e030a4eafff81d335c59","6a70e9c799a6ed30c5317335",
  "6a762d74b85b940800d21ebc","6a762dfdb85b940800d22156","6a7a17625d8258e6a39cb66c",
  "6a7a217a5d8258e6a39cbcbe","6a7f754cf642420dd20cf51c","6a7f7567f642420dd20cf604",
  "6a835d052abf3e76324b5889","6a888fbc8650baf1b0867b52","6a88998b8650baf1b086812a",
  "6a8c91733f3e96ae214a136c"
];
const AGGREGATE_ID = "6a91db24840b39a658af1ba7";

async function run() {
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/fono_inova_prod';
    await mongoose.connect(uri);

    for (const id of IDS) {
        const p = await Payment.findById(id).lean();
        const apptId = p.appointment;
        let apptForms = null;
        if (apptId) {
            const appt = await Appointment.findById(apptId).select('paymentForms paymentMethod').lean();
            apptForms = appt ? { paymentMethod: appt.paymentMethod, paymentForms: appt.paymentForms } : 'APPT_NOT_FOUND';
        }
        console.log(`Payment ${id} | amount=${p.amount} | paymentMethod=${p.paymentMethod} | appt=${apptId}`);
        console.log(`  splitMethods=${JSON.stringify(p.splitMethods)}`);
        console.log(`  appt.paymentForms=${JSON.stringify(apptForms)}`);
    }

    const agg = await Payment.findById(AGGREGATE_ID).lean();
    console.log(`\nAggregate ${AGGREGATE_ID} | amount=${agg.amount} | paymentMethod=${agg.paymentMethod} | appt=${agg.appointment}`);
    console.log(`  splitMethods=${JSON.stringify(agg.splitMethods)}`);

    await mongoose.disconnect();
}
run().catch(e => { console.error(e); process.exit(1); });
