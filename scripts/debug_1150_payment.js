import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

import Patient from '../models/Patient.js';
import Payment from '../models/Payment.js';
import Appointment from '../models/Appointment.js';

async function findRecentPayments() {
    try {
        await mongoose.connect(process.env.MONGO_URI);

        const patient = await Patient.findOne({ fullName: /Henre Gabriel/i });
        if (!patient) {
            console.log('Paciente não encontrado');
            return;
        }

        // Buscar pagamentos de hoje (03/03/2026)
        const startOfToday = new Date('2026-03-03T00:00:00Z');
        const payments = await Payment.find({
            patient: patient._id,
            createdAt: { $gte: startOfToday }
        }).sort({ createdAt: -1 });

        console.log(`Encontrados ${payments.length} pagamentos hoje para Henre:`);
        for (const p of payments) {
            console.log(`- ID: ${p._id}`);
            console.log(`  CreatedAt: ${p.createdAt} (ISO)`);
            console.log(`  Amount: ${p.amount}`);
            console.log(`  ServiceType: ${p.serviceType}`);
            console.log(`  Appointment: ${p.appointment}`);
            console.log(`  Session: ${p.session}`);
            console.log(`  Notes: ${p.notes}`);

            if (p.appointment) {
                const appt = await Appointment.findById(p.appointment).lean();
                console.log(`  Appt Status: ${appt ? appt.operationalStatus : 'NÃO ENCONTRADO'}`);
            }
            console.log('---');
        }

    } catch (err) {
        console.error('Erro:', err);
    } finally {
        await mongoose.disconnect();
    }
}

findRecentPayments();
