#!/usr/bin/env node
/**
 * Teste de fluxo: Débito → Pagamento → Saldo abatido
 * 
 * Cenário: 
 * 1. Paciente tem débito de 100
 * 2. Faz pagamento de 90
 * 3. Saldo deve mostrar 10 (não 100)
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Carrega .env
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import PatientBalance from '../models/PatientBalance.js';

console.log('🚀 Teste Balance Payment Flow - Iniciando...\n');

const TEST_PATIENT_ID = new mongoose.Types.ObjectId();

async function connectDB() {
  if (!process.env.MONGO_URI) {
    console.error('❌ MONGO_URI não definido no .env');
    process.exit(1);
  }
  
  await mongoose.connect(process.env.MONGO_URI, {
    readPreference: 'primary',
    retryWrites: true,
    w: 'majority'
  });
  console.log('✅ Conectado ao MongoDB\n');
}

async function test() {
  try {
    await connectDB();
    
    // ============================================================
    // PASSO 1: Criar um débito de 100
    // ============================================================
    console.log('1️⃣  Criando débito de 100...');
    
    let balance = await PatientBalance.getOrCreate(TEST_PATIENT_ID);
    await balance.addDebit(100, 'Sessão de teste - Débito 100', null, null, null);
    
    // Verifica saldo após débito
    balance = await PatientBalance.findOne({ patient: TEST_PATIENT_ID });
    console.log(`   💰 Saldo após débito: ${balance.currentBalance}`);
    console.log(`   📊 Total debitado: ${balance.totalDebited}`);
    console.log(`   📊 Total creditado: ${balance.totalCredited}`);
    
    if (balance.currentBalance !== 100) {
      console.log('   ❌ ERRO: Saldo deveria ser 100 após débito');
      process.exit(1);
    }
    console.log('   ✅ Débito criado corretamente\n');
    
    // ============================================================
    // PASSO 2: Fazer pagamento de 90
    // ============================================================
    console.log('2️⃣  Fazendo pagamento de 90...');
    
    await balance.addPayment(90, 'dinheiro', 'Pagamento parcial - 90', null);
    
    // Verifica saldo após pagamento
    balance = await PatientBalance.findOne({ patient: TEST_PATIENT_ID });
    console.log(`   💰 Saldo após pagamento: ${balance.currentBalance}`);
    console.log(`   📊 Total debitado: ${balance.totalDebited}`);
    console.log(`   📊 Total creditado: ${balance.totalCredited}`);
    
    // ============================================================
    // PASSO 3: Verificar resultado
    // ============================================================
    console.log('\n3️⃣  Verificando resultado...');
    
    // O saldo deve ser 10 (100 - 90)
    if (balance.currentBalance !== 10) {
      console.log(`   ❌ ERRO: Saldo deveria ser 10, mas é ${balance.currentBalance}`);
      console.log(`   💡 Débito: 100 | Pagamento: 90 | Esperado: 10 | Atual: ${balance.currentBalance}`);
      process.exit(1);
    }
    
    // Verificar transações
    const debitTransactions = balance.transactions.filter(t => t.type === 'debit');
    const paymentTransactions = balance.transactions.filter(t => t.type === 'payment');
    
    console.log(`   📝 Transações de débito: ${debitTransactions.length}`);
    console.log(`   📝 Transações de pagamento: ${paymentTransactions.length}`);
    
    if (debitTransactions.length !== 1 || debitTransactions[0].amount !== 100) {
      console.log('   ❌ ERRO: Débito não registrado corretamente');
      process.exit(1);
    }
    
    if (paymentTransactions.length !== 1 || paymentTransactions[0].amount !== 90) {
      console.log('   ❌ ERRO: Pagamento não registrado corretamente');
      process.exit(1);
    }
    
    console.log('\n✅ TESTE PASSOU!');
    console.log('   Saldo foi abatido corretamente!');
    console.log('   Débito: 100 | Pagamento: 90 | Saldo final: 10\n');
    
    // ============================================================
    // TESTE 2: Pagamento total (zera saldo)
    // ============================================================
    console.log('4️⃣  Teste 2: Pagamento total...\n');
    
    const patientId2 = new mongoose.Types.ObjectId();
    
    // Cria débito de 150
    let balance2 = await PatientBalance.getOrCreate(patientId2);
    await balance2.addDebit(150, 'Sessão de teste - Débito 150', null, null, null);
    
    // Paga integralmente
    await balance2.addPayment(150, 'cartao_credito', 'Pagamento total', null);
    
    // Verifica
    balance2 = await PatientBalance.findOne({ patient: patientId2 });
    
    console.log(`   💰 Saldo após pagamento total: ${balance2.currentBalance}`);
    
    if (balance2.currentBalance !== 0) {
      console.log(`   ❌ ERRO: Saldo deveria ser 0, mas é ${balance2.currentBalance}`);
      process.exit(1);
    }
    
    console.log('✅ TESTE 2 PASSOU!');
    console.log('   Saldo zerado corretamente!\n');
    
    // Cleanup
    console.log('🧹 Limpando dados de teste...');
    await PatientBalance.deleteOne({ patient: TEST_PATIENT_ID });
    await PatientBalance.deleteOne({ patient: patientId2 });
    console.log('   ✅ Dados limpos\n');
    
    await mongoose.disconnect();
    console.log('👋 Desconectado do MongoDB');
    process.exit(0);
    
  } catch (error) {
    console.error('\n💥 Erro:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

test();
