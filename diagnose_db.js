import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Appointment from './models/Appointment.js';
import PreAgendamento from './models/PreAgendamento.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, './.env') });

async function diagnose() {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB");

    const date = "2026-02-16";
    console.log(`\n--- Diagnóstico para ${date} ---`);

    const appts = await Appointment.find({ date })
        .populate('patient doctor')
        .lean();

    console.log(`Total Appts in DB for ${date}:`, appts.length);

    appts.forEach(a => {
        const pName = a.patient?.fullName || a.patientName || (typeof a.patient === 'string' ? a.patient : 'N/A');
        const dName = a.doctor?.fullName || a.professionalName || 'N/A';
        console.log(`- [${a.time}] ${pName} | Doc: ${dName} | Status: ${a.operationalStatus} | ID: ${a._id}`);
        if (pName.includes("Helo")) {
            console.log("  >>> HELOISA FOUND:", JSON.stringify(a, null, 2));
        }
    });

    const preAppts = await PreAgendamento.find({ preferredDate: date }).lean();
    console.log(`\nTotal Pre-Appts in DB for ${date}:`, preAppts.length);
    preAppts.forEach(p => {
        const pName = p.patientInfo?.fullName || "N/A";
        console.log(`- [PRE ${p.preferredTime}] ${pName} | Status: ${p.status} | ID: ${p._id}`);
    });

    await mongoose.disconnect();
}

diagnose().catch(console.error);
