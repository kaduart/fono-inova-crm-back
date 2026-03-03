import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

import Payment from '../models/Payment.js';
import Patient from '../models/Patient.js';

async function findAllRecentPayments() {
    try {
        await mongoose.connect(process.env.MONGO_URI);

        // Buscar todos os pagamentos de hoje
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);

        const payments = await Payment.find({
            createdAt: { $gte: startOfToday }
        })
            .sort({ createdAt: -1 })
            .populate('patient', 'fullName')
            .lean();

        console.log(`Encontrados ${payments.length} pagamentos hoje no sistema:`);
        for (const p of payments) {
            console.log(`- ID: ${p._id}`);
            console.log(`  CreatedAt: ${p.createdAt} (ISO)`);
            console.log(`  Paciente: ${p.patient ? p.patient.fullName : 'NÃO VINCULADO'}`);
            console.log(`  Amount: ${p.amount}`);
            console.log(`  ServiceType: ${p.serviceType}`);
            console.log(`  Appointment: ${p.appointment || 'NÃO TEM'}`);
            console.log(`  Session: ${p.session || 'NÃO TEM'}`);
            console.log(`  Notes: ${p.notes}`);
            console.log('---');
        }

    } catch (err) {
        console.error('Erro:', err);
    } finally {
        await mongoose.disconnect();
    }
}

findAllRecentPayments();
