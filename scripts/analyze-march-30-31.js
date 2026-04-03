#!/usr/bin/env node
/**
 * Análise dos dias 30 e 31 de março no balance do paciente
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import PatientBalance from '../models/PatientBalance.js';

const PATIENT_ID = '685b0cfaaec14c7163585b5b';

async function connectDB() {
  await mongoose.connect(process.env.MONGO_URI, {
    readPreference: 'primary',
    retryWrites: true,
    w: 'majority'
  });
  console.log('✅ Conectado ao MongoDB\n');
}

async function analyze() {
  try {
    await connectDB();
    
    const balance = await PatientBalance.findOne({ patient: PATIENT_ID });
    
    if (!balance) {
      console.log('❌ Balance não encontrado');
      process.exit(1);
    }
    
    // Filtrar transações de 30 e 31/03/2026
    const transactions = balance.transactions || [];
    
    const march30 = new Date('2026-03-30');
    const april1 = new Date('2026-04-01');
    
    const marchTransactions = transactions.filter(t => {
      const date = new Date(t.transactionDate);
      return date >= march30 && date < april1;
    });
    
    console.log('📅 TRANSAÇÕES DE 30 E 31 DE MARÇO:\n');
    console.log('=' .repeat(80));
    
    marchTransactions.sort((a, b) => new Date(a.transactionDate) - new Date(b.transactionDate));
    
    let totalDebits = 0;
    let totalPayments = 0;
    
    marchTransactions.forEach((t, i) => {
      const date = new Date(t.transactionDate).toLocaleString('pt-BR');
      const isPaid = t.isPaid ? '✅ PAGO' : '❌ NÃO PAGO';
      
      console.log(`\n${i + 1}. ${t.type.toUpperCase()} - R$ ${t.amount}`);
      console.log(`   Data: ${date}`);
      console.log(`   Descrição: ${t.description}`);
      console.log(`   Status: ${isPaid}`);
      
      if (t.type === 'debit') {
        totalDebits += t.amount;
        console.log(`   isPaid: ${t.isPaid}, paidAmount: ${t.paidAmount}`);
      } else if (t.type === 'payment') {
        totalPayments += t.amount;
      }
      
      if (t.sessionId) console.log(`   Session: ${t.sessionId}`);
      if (t.appointmentId) console.log(`   Appointment: ${t.appointmentId}`);
    });
    
    console.log('\n' + '=' .repeat(80));
    console.log(`\n💰 RESUMO:`);
    console.log(`   Débitos: R$ ${totalDebits}`);
    console.log(`   Pagamentos: R$ ${totalPayments}`);
    console.log(`   Saldo desses dias: R$ ${totalDebits - totalPayments}`);
    
    // Verificar saldo atual
    console.log(`\n📊 SALDO ATUAL DO PACIENTE:`);
    console.log(`   currentBalance: R$ ${balance.currentBalance}`);
    console.log(`   totalDebited: R$ ${balance.totalDebited}`);
    console.log(`   totalCredited: R$ ${balance.totalCredited}`);
    
    await mongoose.disconnect();
    
  } catch (error) {
    console.error('Erro:', error);
    process.exit(1);
  }
}

analyze();
