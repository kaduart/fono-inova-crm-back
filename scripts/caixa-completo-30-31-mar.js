#!/usr/bin/env node
/**
 * Relatório Completo - Dias 30 e 31/03/2026
 * Inclui: PatientBalance, Sessões, Agendamentos, Pagamentos
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

async function verificarPatientBalance(patientId, dataInicio, dataFim) {
  console.log(`\n💳 PATIENT BALANCE DO PACIENTE (${patientId}):\n`);
  
  const balance = await PatientBalance.findOne({ patient: patientId });
  if (!balance) {
    console.log('   ❌ Nenhum balance encontrado\n');
    return;
  }
  
  // Transações no período
  const transacoes = balance.transactions.filter(t => {
    const date = new Date(t.transactionDate);
    return date >= dataInicio && date <= dataFim;
  });
  
  console.log(`   Transações no período: ${transacoes.length}\n`);
  
  transacoes.forEach((t, i) => {
    const date = new Date(t.transactionDate).toLocaleString('pt-BR');
    console.log(`   ${i + 1}. ${t.type.toUpperCase()} - R$ ${t.amount}`);
    console.log(`      Data: ${date}`);
    console.log(`      Desc: ${t.description}`);
    console.log(`      isPaid: ${t.isPaid}`);
    if (t.sessionId) console.log(`      Session: ${t.sessionId}`);
    console.log();
  });
  
  console.log(`   Saldo Atual: R$ ${balance.currentBalance}\n`);
}

async function gerarRelatorioPeriodo(dataInicioStr, dataFimStr) {
  const dataInicio = new Date(dataInicioStr);
  dataInicio.setHours(0, 0, 0, 0);
  
  const dataFim = new Date(dataFimStr);
  dataFim.setHours(23, 59, 59, 999);
  
  console.log(`${'='.repeat(80)}`);
  console.log(`📅 PERÍODO: ${dataInicioStr} a ${dataFimStr}`);
  console.log(`${'='.repeat(80)}`);
  
  // SESSÕES
  console.log('\n🩺 SESSÕES:\n');
  const sessions = await Session.find({
    date: { $gte: dataInicio, $lte: dataFim },
    status: 'completed'
  }).populate('patient', 'fullName').populate('doctor', 'fullName').lean();
  
  if (sessions.length === 0) {
    console.log('   Nenhuma sessão encontrada\n');
  } else {
    sessions.forEach((s, i) => {
      console.log(`   ${i + 1}. ${s.patient?.fullName || 'N/A'}`);
      console.log(`      Data: ${new Date(s.date).toLocaleDateString('pt-BR')}`);
      console.log(`      Horário: ${s.time || 'N/A'}`);
      console.log(`      Tipo: ${s.billingType === 'insurance' ? 'Convênio' : 'Particular'}`);
      console.log(`      Valor: R$ ${s.sessionValue || 0}`);
      console.log(`      Pago: ${s.isPaid ? '✅' : '❌'}`);
      console.log(`      ID: ${s._id}\n`);
    });
  }
  
  // PAGAMENTOS
  console.log('\n💰 PAGAMENTOS:\n');
  const payments = await Payment.find({
    $or: [
      { paidAt: { $gte: dataInicio, $lte: dataFim } },
      { createdAt: { $gte: dataInicio, $lte: dataFim }, status: 'paid' }
    ]
  }).populate('patient', 'fullName').lean();
  
  if (payments.length === 0) {
    console.log('   Nenhum pagamento encontrado\n');
  } else {
    for (const p of payments) {
      console.log(`   • ${p.patient?.fullName || 'N/A'}`);
      console.log(`      Valor: R$ ${p.amount}`);
      console.log(`      Método: ${p.paymentMethod || 'N/A'}`);
      console.log(`      Data Pagamento: ${p.paidAt ? new Date(p.paidAt).toLocaleString('pt-BR') : 'N/A'}`);
      console.log(`      Paciente ID: ${p.patient?._id || 'N/A'}`);
      
      // Verificar balance desse paciente
      if (p.patient?._id) {
        await verificarPatientBalance(p.patient._id, dataInicio, dataFim);
      }
    }
  }
  
  // AGENDAMENTOS
  console.log('\n📋 AGENDAMENTOS:\n');
  const appointments = await Appointment.find({
    date: { $gte: dataInicio, $lte: dataFim }
  }).populate('patient', 'fullName').lean();
  
  if (appointments.length === 0) {
    console.log('   Nenhum agendamento encontrado\n');
  } else {
    appointments.forEach((a, i) => {
      console.log(`   ${i + 1}. ${a.patient?.fullName || 'N/A'}`);
      console.log(`      Data: ${new Date(a.date).toLocaleDateString('pt-BR')}`);
      console.log(`      Horário: ${a.time || 'N/A'}`);
      console.log(`      Status: ${a.operationalStatus || 'N/A'}`);
      console.log();
    });
  }
  
  // RESUMO
  console.log(`${'='.repeat(80)}`);
  console.log('📊 RESUMO:');
  console.log(`   Sessões: ${sessions.length}`);
  console.log(`   Pagamentos: ${payments.length}`);
  console.log(`   Agendamentos: ${appointments.length}`);
  console.log(`${'='.repeat(80)}\n`);
}

async function main() {
  try {
    await connectDB();
    
    // Período de 30/03 a 31/03
    await gerarRelatorioPeriodo('2026-03-30', '2026-03-31');
    
    await mongoose.disconnect();
    console.log('✅ Concluído');
    
  } catch (error) {
    console.error('❌ Erro:', error);
    process.exit(1);
  }
}

main();
