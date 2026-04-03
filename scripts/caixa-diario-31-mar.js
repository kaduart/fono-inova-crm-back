#!/usr/bin/env node
/**
 * Relatório de Caixa Diário - Dia 31/03/2026
 * Mostra: Agendamentos, Sessões, Pagamentos, Convênios, etc.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';
import PatientBalance from '../models/PatientBalance.js';
import Patient from '../models/Patient.js';

async function connectDB() {
  await mongoose.connect(process.env.MONGO_URI, {
    readPreference: 'primary',
    retryWrites: true,
    w: 'majority'
  });
  console.log('✅ Conectado ao MongoDB\n');
}

async function gerarRelatorioCaixa(dataStr) {
  const dataInicio = new Date(dataStr);
  dataInicio.setHours(0, 0, 0, 0);
  
  const dataFim = new Date(dataStr);
  dataFim.setHours(23, 59, 59, 999);
  
  console.log(`\n${'='.repeat(80)}`);
  console.log(`📅 RELATÓRIO DE CAIXA - ${dataStr}`);
  console.log(`${'='.repeat(80)}\n`);
  
  // 1. SESSÕES DO DIA
  console.log('🩺 SESSÕES REALIZADAS:\n');
  const sessions = await Session.find({
    date: { $gte: dataInicio, $lte: dataFim },
    status: 'completed'
  }).populate('patient', 'fullName').populate('doctor', 'fullName').lean();
  
  let totalSessoesParticular = 0;
  let totalSessoesConvenio = 0;
  
  sessions.forEach((s, i) => {
    const tipo = s.billingType === 'insurance' ? 'CONVÊNIO' : 'PARTICULAR';
    const valor = s.sessionValue || 0;
    
    console.log(`${i + 1}. ${s.patient?.fullName || 'N/A'}`);
    console.log(`   Profissional: ${s.doctor?.fullName || 'N/A'}`);
    console.log(`   Tipo: ${tipo} | Valor: R$ ${valor}`);
    console.log(`   Horário: ${s.time || 'N/A'} | Status: ${s.status}`);
    console.log(`   Pago: ${s.isPaid ? '✅ SIM' : '❌ NÃO'}`);
    
    if (s.billingType === 'insurance') {
      totalSessoesConvenio += valor;
      console.log(`   Convênio: ${s.insuranceProvider || 'N/A'}`);
    } else {
      totalSessoesParticular += valor;
    }
    console.log();
  });
  
  console.log(`   Subtotal Particular: R$ ${totalSessoesParticular}`);
  console.log(`   Subtotal Convênio: R$ ${totalSessoesConvenio}`);
  console.log(`   Total Sessões: R$ ${totalSessoesParticular + totalSessoesConvenio}\n`);
  
  // 2. PAGAMENTOS RECEBIDOS NO DIA
  console.log('💰 PAGAMENTOS RECEBIDOS:\n');
  const payments = await Payment.find({
    paidAt: { $gte: dataInicio, $lte: dataFim },
    status: 'paid'
  }).populate('patient', 'fullName').lean();
  
  let totalDinheiro = 0;
  let totalCartaoCredito = 0;
  let totalCartaoDebito = 0;
  let totalPix = 0;
  
  payments.forEach((p, i) => {
    const metodo = p.paymentMethod || 'N/A';
    console.log(`${i + 1}. ${p.patient?.fullName || 'N/A'}`);
    console.log(`   Valor: R$ ${p.amount} | Método: ${metodo.toUpperCase()}`);
    console.log(`   Horário: ${new Date(p.paidAt).toLocaleTimeString('pt-BR')}`);
    console.log();
    
    switch(metodo) {
      case 'dinheiro': totalDinheiro += p.amount; break;
      case 'cartao_credito': totalCartaoCredito += p.amount; break;
      case 'cartao_debito': totalCartaoDebito += p.amount; break;
      case 'pix': totalPix += p.amount; break;
    }
  });
  
  const totalPagamentos = totalDinheiro + totalCartaoCredito + totalCartaoDebito + totalPix;
  
  console.log(`   💵 Dinheiro: R$ ${totalDinheiro}`);
  console.log(`   💳 Cartão Crédito: R$ ${totalCartaoCredito}`);
  console.log(`   💳 Cartão Débito: R$ ${totalCartaoDebito}`);
  console.log(`   📱 PIX: R$ ${totalPix}`);
  console.log(`   💰 TOTAL PAGAMENTOS: R$ ${totalPagamentos}\n`);
  
  // 3. AGENDAMENTOS DO DIA
  console.log('📋 AGENDAMENTOS DO DIA:\n');
  const appointments = await Appointment.find({
    date: { $gte: dataInicio, $lte: dataFim }
  }).populate('patient', 'fullName').populate('doctor', 'fullName').lean();
  
  appointments.forEach((a, i) => {
    console.log(`${i + 1}. ${a.patient?.fullName || 'N/A'}`);
    console.log(`   Profissional: ${a.doctor?.fullName || 'N/A'}`);
    console.log(`   Horário: ${a.time || 'N/A'}`);
    console.log(`   Status: ${a.operationalStatus || 'N/A'}`);
    console.log(`   Tipo: ${a.billingType === 'insurance' ? 'Convênio' : 'Particular'}`);
    console.log();
  });
  
  console.log(`   Total Agendamentos: ${appointments.length}\n`);
  
  // 4. RESUMO DO DIA
  console.log(`${'='.repeat(80)}`);
  console.log('📊 RESUMO DO DIA:\n');
  console.log(`   Sessões Realizadas: ${sessions.length}`);
  console.log(`   - Particular: R$ ${totalSessoesParticular}`);
  console.log(`   - Convênio: R$ ${totalSessoesConvenio}`);
  console.log(`   Pagamentos Recebidos: R$ ${totalPagamentos}`);
  console.log(`   Agendamentos: ${appointments.length}`);
  console.log(`${'='.repeat(80)}\n`);
}

async function main() {
  try {
    await connectDB();
    
    // Gerar para 31/03/2026
    await gerarRelatorioCaixa('2026-03-31');
    
    await mongoose.disconnect();
    console.log('✅ Relatório concluído');
    
  } catch (error) {
    console.error('❌ Erro:', error);
    process.exit(1);
  }
}

main();
