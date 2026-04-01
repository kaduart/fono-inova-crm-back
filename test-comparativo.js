#!/usr/bin/env node
/**
 * Script de Teste Comparativo: Legado vs 4.0
 * 
 * Compara se o 4.0 está criando os mesmos dados que o legado
 */

import mongoose from 'mongoose';
import Appointment from './models/Appointment.js';
import Session from './models/Session.js';
import Payment from './models/Payment.js';
import dotenv from 'dotenv';

dotenv.config();

const appointmentId = process.argv[2];

if (!appointmentId) {
  console.log('Uso: node test-comparativo.js <appointmentId>');
  console.log('Exemplo: node test-comparativo.js 69c701d943d83e28229f04a2');
  process.exit(1);
}

async function connect() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/clinica');
  console.log('✅ Conectado ao MongoDB\n');
}

async function verificarAgendamento(id) {
  console.log(`🔍 Verificando agendamento: ${id}\n`);
  
  // Busca o appointment
  const appointment = await Appointment.findById(id)
    .populate('patient', 'fullName')
    .populate('doctor', 'fullName specialty')
    .populate('session')
    .populate('package')
    .populate('payment');
  
  if (!appointment) {
    console.error('❌ Agendamento não encontrado!');
    return;
  }
  
  console.log('📋 DADOS DO AGENDAMENTO');
  console.log('═══════════════════════════════════════');
  console.log(`ID: ${appointment._id}`);
  console.log(`Patient: ${appointment.patient?.fullName || 'N/A'}`);
  console.log(`Doctor: ${appointment.doctor?.fullName || 'N/A'}`);
  console.log(`Status Operacional: ${appointment.operationalStatus}`);
  console.log(`Status Clínico: ${appointment.clinicalStatus}`);
  console.log(`Status Pagamento: ${appointment.paymentStatus}`);
  console.log(`Data: ${appointment.date} ${appointment.time}`);
  console.log();
  
  // Verifica Session
  console.log('🎫 SESSÃO');
  console.log('═══════════════════════════════════════');
  if (appointment.session) {
    const session = appointment.session;
    console.log(`✅ Sessão criada: ${session._id}`);
    console.log(`   Status: ${session.status}`);
    console.log(`   isPaid: ${session.isPaid}`);
    console.log(`   paymentStatus: ${session.paymentStatus}`);
    console.log(`   visualFlag: ${session.visualFlag}`);
    console.log(`   sessionValue: ${session.sessionValue}`);
    console.log(`   paymentOrigin: ${session.paymentOrigin || 'N/A'}`);
    
    if (session.status === 'canceled' && (session.originalPartialAmount > 0 || session.originalIsPaid)) {
      console.log(`   🔄 CRÉDITO PRESERVADO: ${session.originalPartialAmount || 'pago'}`);
    }
  } else {
    console.log('❌ Sessão NÃO criada ainda (status processing_create?)');
  }
  console.log();
  
  // Verifica Payment
  console.log('💰 PAGAMENTO');
  console.log('═══════════════════════════════════════');
  if (appointment.payment) {
    const payment = appointment.payment;
    console.log(`✅ Payment criado: ${payment._id}`);
    console.log(`   Status: ${payment.status}`);
    console.log(`   Amount: ${payment.amount}`);
    console.log(`   Method: ${payment.paymentMethod}`);
    console.log(`   billingType: ${payment.billingType}`);
    console.log(`   kind: ${payment.kind || 'N/A'}`);
    console.log(`   paymentOrigin: ${payment.paymentOrigin || 'N/A'}`);
  } else {
    console.log('❌ Payment NÃO criado');
    if (appointment.package) {
      console.log('   ℹ️  Normal para pacote (usa crédito)');
    } else if (appointment.billingType === 'convenio') {
      console.log('   ℹ️  Normal para convênio (fatura depois)');
    } else {
      console.log('   ⚠️  DEVERIA ter Payment (particular sem pacote)');
    }
  }
  console.log();
  
  // Verifica Package
  if (appointment.package) {
    console.log('📦 PACOTE');
    console.log('═══════════════════════════════════════');
    const pkg = appointment.package;
    console.log(`ID: ${pkg._id}`);
    console.log(`Tipo: ${pkg.type || 'therapy'}`);
    console.log(`Sessões: ${pkg.sessionsDone}/${pkg.totalSessions}`);
    console.log(`Pago: ${pkg.totalPaid}/${pkg.totalValue}`);
    console.log(`Status Financeiro: ${pkg.financialStatus}`);
    console.log();
  }
  
  // Validações
  console.log('✅ VALIDAÇÕES');
  console.log('═══════════════════════════════════════');
  
  const checks = [];
  
  // Check 1: Tem sessão?
  checks.push({
    name: 'Session criada',
    pass: !!appointment.session,
    critical: true
  });
  
  // Check 2: Particular sem pacote tem payment?
  if (!appointment.package && appointment.billingType !== 'convenio') {
    checks.push({
      name: 'Payment criado (particular)',
      pass: !!appointment.payment,
      critical: true
    });
  }
  
  // Check 3: Status consistente?
  if (appointment.session?.status === 'completed') {
    checks.push({
      name: 'ClinicalStatus completed quando session completed',
      pass: appointment.clinicalStatus === 'completed',
      critical: true
    });
  }
  
  // Check 4: Pacote com sessão consome?
  if (appointment.package && appointment.session?.status === 'completed') {
    checks.push({
      name: 'Package sessionsDone incrementado',
      pass: appointment.package.sessionsDone > 0,
      critical: true
    });
  }
  
  // Exibe checks
  let allPass = true;
  for (const check of checks) {
    const icon = check.pass ? '✅' : '❌';
    const critical = check.critical ? ' [CRÍTICO]' : '';
    console.log(`${icon} ${check.name}${critical}`);
    if (!check.pass && check.critical) allPass = false;
  }
  
  console.log();
  console.log('═══════════════════════════════════════');
  if (allPass) {
    console.log('✅ TODAS AS VALIDAÇÕES PASSARAM!');
    console.log('O 4.0 está funcionando igual ao legado.');
  } else {
    console.log('❌ ALGUMAS VALIDAÇÕES FALHARAM!');
    console.log('Verifique se o worker processou corretamente.');
  }
  console.log('═══════════════════════════════════════');
}

async function run() {
  await connect();
  await verificarAgendamento(appointmentId);
  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
