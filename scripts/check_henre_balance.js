import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

import Patient from '../models/Patient.js';
import PatientBalance from '../models/PatientBalance.js';

async function checkBalance() {
    try {
        await mongoose.connect(process.env.MONGO_URI);

        const patient = await Patient.findOne({ fullName: /Henre Gabriel/i });
        if (!patient) {
            console.log('Paciente não encontrado');
            return;
        }

        const balance = await PatientBalance.findOne({ patient: patient._id }).lean();
        if (!balance) {
            console.log('Saldo não encontrado para o paciente');
            return;
        }

        console.log(`Saldo de ${patient.fullName}:`);
        console.log(`Current Balance: ${balance.currentBalance}`);

        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);

        const recentTransactions = balance.transactions.filter(t => t.transactionDate >= startOfToday);
        console.log(`Encontradas ${recentTransactions.length} transações hoje:`);

        for (const t of recentTransactions) {
            console.log(`- Type: ${t.type}, Amount: ${t.amount}, Date: ${t.transactionDate}, Desc: ${t.description}`);
        }

    } catch (err) {
        console.error('Erro:', err);
    } finally {
        await mongoose.disconnect();
    }
}

checkBalance();
