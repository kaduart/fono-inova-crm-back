import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

import Patient from '../models/Patient.js';

async function findRecentPatients() {
    try {
        await mongoose.connect(process.env.MONGO_URI);

        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);

        const patients = await Patient.find({
            createdAt: { $gte: startOfToday }
        }).sort({ createdAt: -1 }).lean();

        console.log(`Encontrados ${patients.length} pacientes criados hoje:`);
        for (const p of patients) {
            console.log(`- ID: ${p._id}, Nome: ${p.fullName}, CreatedAt: ${p.createdAt}`);
        }

    } catch (err) {
        console.error('Erro:', err);
    } finally {
        await mongoose.disconnect();
    }
}

findRecentPatients();
