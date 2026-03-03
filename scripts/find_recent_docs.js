import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Patient from '../models/Patient.js';

async function findRecentDocs() {
    try {
        await mongoose.connect(process.env.MONGO_URI);

        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);

        const appts = await Appointment.find({
            createdAt: { $gte: startOfToday }
        }).sort({ createdAt: -1 }).populate('patient', 'fullName').lean();

        console.log(`Encontrados ${appts.length} agendamentos criados hoje:`);
        for (const a of appts) {
            console.log(`- ID: ${a._id}, Paciente: ${a.patient ? a.patient.fullName : 'N/A'}, Status: ${a.operationalStatus}, Payment: ${a.payment || 'NÃO TEM'}`);
        }

        const sessions = await Session.find({
            createdAt: { $gte: startOfToday }
        }).sort({ createdAt: -1 }).populate('patient', 'fullName').lean();

        console.log(`\nEncontradas ${sessions.length} sessões criadas hoje:`);
        for (const s of sessions) {
            console.log(`- ID: ${s._id}, Paciente: ${s.patient ? s.patient.fullName : 'N/A'}, Status: ${s.status}, ApptID: ${s.appointmentId || 'NÃO TEM'}`);
        }

    } catch (err) {
        console.error('Erro:', err);
    } finally {
        await mongoose.disconnect();
    }
}

findRecentDocs();
