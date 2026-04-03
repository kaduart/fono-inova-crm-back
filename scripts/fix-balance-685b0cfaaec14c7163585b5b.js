#!/usr/bin/env node
/**
 * Correção do saldo do paciente 685b0cfaaec14c7163585b5b
 * 
 * Problema: Pagamentos registrados mas não abateram o saldo
 * Solução: Recalcular e corrigir os valores
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
  if (!process.env.MONGO_URI) {
    console.error('❌ MONGO_URI não definido');
    process.exit(1);
  }
  
  await mongoose.connect(process.env.MONGO_URI, {
    readPreference: 'primary',
    retryWrites: true,
    w: 'majority'
  });
  console.log('✅ Conectado ao MongoDB\n');
}

async function fixBalance() {
  try {
    await connectDB();
    
    console.log('🔍 Analisando transações do paciente:', PATIENT_ID);
    console.log('=' .repeat(60));
    
    const balance = await PatientBalance.findOne({ patient: PATIENT_ID });
    
    if (!balance) {
      console.log('❌ Balance não encontrado');
      process.exit(1);
    }
    
    // Análise das transações
    const transactions = balance.transactions || [];
    
    console.log('\n📊 ESTADO ATUAL:');
    console.log(`   currentBalance: ${balance.currentBalance}`);
    console.log(`   totalDebited: ${balance.totalDebited}`);
    console.log(`   totalCredited: ${balance.totalCredited}`);
    console.log(`   Total transações: ${transactions.length}`);
    
    // Classificar transações
    const debits = transactions.filter(t => t.type === 'debit');
    const payments = transactions.filter(t => t.type === 'payment');
    const credits = transactions.filter(t => t.type === 'credit');
    
    console.log('\n📋 TRANSAÇÕES:');
    console.log(`   Débitos: ${debits.length}`);
    console.log(`   Pagamentos: ${payments.length}`);
    console.log(`   Créditos: ${credits.length}`);
    
    // Calcular valores
    const totalDebitAmount = debits.reduce((sum, t) => sum + (t.amount || 0), 0);
    const totalPaymentAmount = payments.reduce((sum, t) => sum + (t.amount || 0), 0);
    const totalCreditAmount = credits.reduce((sum, t) => sum + (t.amount || 0), 0);
    
    // Débitos não pagos (isPaid = false)
    const unpaidDebits = debits.filter(t => !t.isPaid);
    const unpaidAmount = unpaidDebits.reduce((sum, t) => sum + (t.amount || 0), 0);
    
    console.log('\n💰 CÁLCULO:');
    console.log(`   Soma dos débitos: ${totalDebitAmount}`);
    console.log(`   Soma dos pagamentos: ${totalPaymentAmount}`);
    console.log(`   Soma dos créditos: ${totalCreditAmount}`);
    console.log(`   Débitos NÃO pagos: ${unpaidDebits.length} = ${unpaidAmount}`);
    
    // Saldo correto = apenas débitos não pagos
    const correctBalance = unpaidAmount;
    const correctCredited = totalPaymentAmount + totalCreditAmount;
    const correctDebited = totalDebitAmount;
    
    console.log('\n✅ VALORES CORRETOS:');
    console.log(`   currentBalance deve ser: ${correctBalance}`);
    console.log(`   totalDebited deve ser: ${correctDebited}`);
    console.log(`   totalCredited deve ser: ${correctCredited}`);
    
    console.log('\n🔧 DETALHES DOS DÉBITOS NÃO PAGOS:');
    unpaidDebits.forEach((t, i) => {
      console.log(`   ${i+1}. ${t.description} - R$ ${t.amount}`);
    });
    
    // Verificar se precisa correção
    const needsFix = (
      balance.currentBalance !== correctBalance ||
      balance.totalDebited !== correctDebited ||
      balance.totalCredited !== correctCredited
    );
    
    if (!needsFix) {
      console.log('\n✅ O saldo já está correto! Nenhuma ação necessária.');
      await mongoose.disconnect();
      process.exit(0);
    }
    
    console.log('\n⚠️  CORREÇÃO NECESSÁRIA:');
    console.log(`   currentBalance: ${balance.currentBalance} → ${correctBalance}`);
    console.log(`   totalDebited: ${balance.totalDebited} → ${correctDebited}`);
    console.log(`   totalCredited: ${balance.totalCredited} → ${correctCredited}`);
    
    // Aplicar correção
    console.log('\n📝 Aplicando correção...');
    
    balance.currentBalance = correctBalance;
    balance.totalDebited = correctDebited;
    balance.totalCredited = correctCredited;
    balance.lastTransactionAt = new Date();
    
    await balance.save();
    
    console.log('✅ Correção aplicada com sucesso!');
    
    // Verificar
    const updated = await PatientBalance.findOne({ patient: PATIENT_ID });
    console.log('\n📊 NOVO ESTADO:');
    console.log(`   currentBalance: ${updated.currentBalance}`);
    console.log(`   totalDebited: ${updated.totalDebited}`);
    console.log(`   totalCredited: ${updated.totalCredited}`);
    
    await mongoose.disconnect();
    console.log('\n👋 Concluído');
    process.exit(0);
    
  } catch (error) {
    console.error('\n💥 Erro:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

fixBalance();
