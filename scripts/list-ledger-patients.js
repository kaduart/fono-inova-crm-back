#!/usr/bin/env node
/**
 * 📋 Lista todos os pacientes com saldo no ledger (PatientBalance)
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import Patient from '../models/Patient.js';
import PatientBalance from '../models/PatientBalance.js';

async function run() {
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/fono_inova_prod';
    await mongoose.connect(uri);
    console.log('[LEDGER] Conectado. Buscando pacientes com saldo...\n');

    const balances = await PatientBalance.find({ currentBalance: { $ne: 0 } })
        .populate('patient', 'fullName')
        .sort({ currentBalance: -1 })
        .lean();

    if (balances.length === 0) {
        console.log('[LEDGER] Nenhum paciente com saldo no ledger.');
        await mongoose.disconnect();
        return;
    }

    console.log(`[LEDGER] ${balances.length} paciente(s) com saldo no ledger:\n`);

    for (const b of balances) {
        const patientName = b.patient?.fullName || 'Desconhecido';
        const pending = (b.transactions || []).filter(t => t.type === 'debit');
        const paid = (b.transactions || []).filter(t => t.type === 'credit' || t.type === 'payment');

        console.log(`👤 ${patientName}`);
        console.log(`   Saldo: ${b.currentBalance > 0 ? '💰 Deve' : '✅ Crédito'} ${b.currentBalance}`);
        console.log(`   Transações: ${b.transactions?.length || 0} total`);
        console.log(`   → Débitos pendentes: ${pending.length}`);
        console.log(`   → Pagamentos/créditos: ${paid.length}`);

        if (pending.length > 0) {
            console.log(`   Últimos débitos:`);
            pending.slice(-5).forEach(t => {
                console.log(`      • ${t.description || 'Débito'} | R$ ${t.amount} | ${new Date(t.transactionDate).toLocaleDateString('pt-BR')}`);
            });
        }
        console.log('');
    }

    await mongoose.disconnect();
}

run().catch(err => {
    console.error('[LEDGER] Erro:', err);
    process.exit(1);
});
