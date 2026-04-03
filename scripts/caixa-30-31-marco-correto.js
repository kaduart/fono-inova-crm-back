#!/usr/bin/env node
/**
 * Caixa 30 e 31/03/2026 - CORRETO (datas como string)
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

async function connectDB() {
  await mongoose.connect(process.env.MONGO_URI, {
    readPreference: 'primary',
    retryWrites: true,
    w: 'majority'
  });
  console.log('✅ Conectado ao MongoDB\n');
}

async function gerarCaixa(dia) {
  console.log(`${'='.repeat(80)}`);
  console.log(`📅 CAIXA DO DIA: ${dia}`);
  console.log(`${'='.repeat(80)}\n`);
  
  // Agendamentos (date é string no formato YYYY-MM-DD)
  const agendamentos = await Appointment.find({
    date: dia
  }).populate('patient', 'fullName').populate('doctor', 'fullName').lean();
  
  console.log(`📋 AGENDAMENTOS: ${agendamentos.length}\n`);
  console.log('-'.repeat(80));
  
  let cancelados = 0;
  let confirmados = 0;
  let totalParticular = 0;
  let totalConvenio = 0;
  
  agendamentos.forEach((a, i) => {
    const isCancelado = a.operationalStatus === 'canceled';
    const isConfirmado = a.operationalStatus === 'scheduled' || a.operationalStatus === 'confirmed';
    
    if (isCancelado) cancelados++;
    if (isConfirmado) confirmados++;
    
    const tipo = a.billingType === 'insurance' ? 'CONVÊNIO' : 'PARTICULAR';
    const valor = a.paymentAmount || a.sessionValue || 0;
    
    if (a.billingType === 'insurance') totalConvenio += valor;
    else totalParticular += valor;
    
    console.log(`${i + 1}. ${a.patient?.fullName || 'N/A'}`);
    console.log(`   Horário: ${a.time || 'N/A'}`);
    console.log(`   Profissional: ${a.doctor?.fullName || 'N/A'}`);
    console.log(`   Tipo: ${tipo}`);
    console.log(`   Status: ${a.operationalStatus}${isCancelado ? ' ❌' : isConfirmado ? ' ✅' : ''}`);
    console.log(`   Pagamento: ${a.paymentStatus || 'N/A'}`);
    console.log(`   Valor: R$ ${valor}`);
    console.log();
  });
  
  console.log('-'.repeat(80));
  console.log(`   ✅ Confirmados: ${confirmados}`);
  console.log(`   ❌ Cancelados: ${cancelados}`);
  console.log(`   💰 Particular: R$ ${totalParticular}`);
  console.log(`   🏥 Convênio: R$ ${totalConvenio}`);
  console.log(`${'='.repeat(80)}\n`);
  
  // Sessões realizadas
  console.log('🩺 SESSÕES REALIZADAS:\n');
  const sessions = await Session.find({
    date: dia,
    status: 'completed'
  }).populate('patient', 'fullName').lean();
  
  if (sessions.length === 0) {
    console.log('   Nenhuma sessão concluída\n');
  } else {
    sessions.forEach((s, i) => {
      console.log(`   ${i + 1}. ${s.patient?.fullName || 'N/A'}`);
      console.log(`      Horário: ${s.time}`);
      console.log(`      Pago: ${s.isPaid ? '✅' : '❌'}`);
      console.log(`      Valor: R$ ${s.sessionValue || 0}`);
      console.log();
    });
  }
  
  // Pagamentos recebidos
  console.log('💰 PAGAMENTOS:\n');
  const dataInicio = new Date(dia + 'T00:00:00.000Z');
  const dataFim = new Date(dia + 'T23:59:59.999Z');
  
  const payments = await Payment.find({
    paidAt: { $gte: dataInicio, $lte: dataFim }
  }).populate('patient', 'fullName').lean();
  
  if (payments.length === 0) {
    console.log('   Nenhum pagamento registrado\n');
  } else {
    payments.forEach((p, i) => {
      console.log(`   ${i + 1}. ${p.patient?.fullName || 'N/A'}`);
      console.log(`      Valor: R$ ${p.amount}`);
      console.log(`      Método: ${p.paymentMethod || 'N/A'}`);
      console.log();
    });
  }
}

async function main() {
  try {
    await connectDB();
    
    // Dia 30/03/2026
    await gerarCaixa('2026-03-30');
    
    // Dia 31/03/2026
    await gerarCaixa('2026-03-31');
    
    await mongoose.disconnect();
    console.log('✅ Concluído');
    
  } catch (error) {
    console.error('❌ Erro:', error);
    process.exit(1);
  }
}

main();
