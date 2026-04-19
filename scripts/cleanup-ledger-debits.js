#!/usr/bin/env node
/**
 * 🧹 Remove débitos do ledger para Isis Caldas Rebelatto
 * Remove transações do tipo 'debit' com descrição 'Sessão fiada'
 * e recalcula o saldo do PatientBalance
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import Patient from '../models/Patient.js';
import PatientBalance from '../models/PatientBalance.js';

const PATIENT_NAME = 'Isis Caldas Rebelatto';

async function run() {
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/fono_inova_prod';
    console.log(`[CLEANUP] Conectando...`);
    await mongoose.connect(uri);

    const patient = await Patient.findOne({ fullName: PATIENT_NAME }).lean();
    if (!patient) {
        console.log(`[CLEANUP] Paciente não encontrado.`);
        await mongoose.disconnect();
        return;
    }

    const patientId = patient._id;
    console.log(`[CLEANUP] Paciente: ${PATIENT_NAME} (${patientId})`);

    const balance = await PatientBalance.findOne({ patient: patientId });
    if (!balance) {
        console.log(`[CLEANUP] PatientBalance não encontrado.`);
        await mongoose.disconnect();
        return;
    }

    console.log(`[CLEANUP] Saldo antes: ${balance.currentBalance}`);
    console.log(`[CLEANUP] Transações antes: ${balance.transactions.length}`);

    // Encontra as transações de débito com "Sessão fiada" ou "fiada" na descrição
    const debitsToRemove = balance.transactions.filter(t =>
        t.type === 'debit' &&
        (t.description?.toLowerCase().includes('fiada') ||
         t.description?.toLowerCase().includes('sessão'))
    );

    console.log(`[CLEANUP] Débitos encontrados para remover: ${debitsToRemove.length}`);
    debitsToRemove.forEach((t, i) => {
        console.log(`  [${i + 1}] ${t.description} | ${t.amount} | ${t.transactionDate}`);
    });

    if (debitsToRemove.length === 0) {
        console.log(`[CLEANUP] Nenhum débito encontrado. Nada a fazer.`);
        await mongoose.disconnect();
        return;
    }

    // Remove as transações
    const idsToRemove = new Set(debitsToRemove.map(t => t._id.toString()));
    balance.transactions = balance.transactions.filter(t => !idsToRemove.has(t._id.toString()));

    // Recalcula o saldo
    const totalDebits = balance.transactions
        .filter(t => t.type === 'debit')
        .reduce((sum, t) => sum + (t.amount || 0), 0);
    const totalCredits = balance.transactions
        .filter(t => t.type === 'credit' || t.type === 'payment')
        .reduce((sum, t) => sum + (t.amount || 0), 0);

    balance.currentBalance = totalDebits - totalCredits;
    balance.totalDebited = totalDebits;
    balance.totalCredited = totalCredits;

    await balance.save();

    console.log(`[CLEANUP] Débitos removidos: ${debitsToRemove.length}`);
    console.log(`[CLEANUP] Saldo depois: ${balance.currentBalance}`);
    console.log(`[CLEANUP] Transações depois: ${balance.transactions.length}`);
    console.log(`[CLEANUP] ✅ Ledger limpo para ${PATIENT_NAME}`);

    await mongoose.disconnect();
}

run().catch(err => {
    console.error('[CLEANUP] Erro:', err);
    process.exit(1);
});
