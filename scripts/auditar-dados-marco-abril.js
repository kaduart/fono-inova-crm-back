#!/usr/bin/env node
/**
 * Auditoria de Dados: Março e Abril/2026
 * Verifica integridade entre Agendamentos, Sessões, Pagamentos e Convênio
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

async function auditarPeriodo(ano, mes) {
  const dataInicio = new Date(ano, mes - 1, 1); // Mês em JS é 0-indexed
  const dataFim = new Date(ano, mes, 1); // Primeiro dia do próximo mês
  
  const mesNome = new Date(ano, mes - 1).toLocaleString('pt-BR', { month: 'long', year: 'numeric' });
  
  console.log(`\n${'='.repeat(80)}`);
  console.log(`📅 AUDITORIA: ${mesNome.toUpperCase()}`);
  console.log(`${'='.repeat(80)}\n`);
  
  // 1. AGENDAMENTOS
  console.log('📋 AGENDAMENTOS:\n');
  const appointments = await Appointment.find({
    date: { $gte: dataInicio, $lt: dataFim }
  }).lean();
  
  const porStatus = {};
  appointments.forEach(a => {
    const status = a.operationalStatus || 'unknown';
    porStatus[status] = (porStatus[status] || 0) + 1;
  });
  
  console.log(`   Total: ${appointments.length}`);
  Object.entries(porStatus).forEach(([status, count]) => {
    console.log(`   - ${status}: ${count}`);
  });
  console.log();
  
  // 2. SESSÕES
  console.log('🩺 SESSÕES:\n');
  const sessions = await Session.find({
    date: { $gte: dataInicio, $lt: dataFim }
  }).lean();
  
  const sessoesPorStatus = {};
  let sessoesPagas = 0;
  let sessoesNaoPagas = 0;
  let totalValorParticular = 0;
  let totalValorConvenio = 0;
  
  sessions.forEach(s => {
    const status = s.status || 'unknown';
    sessoesPorStatus[status] = (sessoesPorStatus[status] || 0) + 1;
    
    if (s.isPaid) sessoesPagas++;
    else sessoesNaoPagas++;
    
    if (s.billingType === 'insurance') {
      totalValorConvenio += s.sessionValue || 0;
    } else {
      totalValorParticular += s.sessionValue || 0;
    }
  });
  
  console.log(`   Total: ${sessions.length}`);
  Object.entries(sessoesPorStatus).forEach(([status, count]) => {
    console.log(`   - ${status}: ${count}`);
  });
  console.log(`   💰 Pagas: ${sessoesPagas} | Não Pagas: ${sessoesNaoPagas}`);
  console.log(`   💵 Particular: R$ ${totalValorParticular.toFixed(2)}`);
  console.log(`   🏥 Convênio: R$ ${totalValorConvenio.toFixed(2)}`);
  console.log();
  
  // 3. PAGAMENTOS
  console.log('💰 PAGAMENTOS:\n');
  const payments = await Payment.find({
    paidAt: { $gte: dataInicio, $lt: dataFim }
  }).lean();
  
  let totalRecebido = 0;
  const porMetodo = {};
  
  payments.forEach(p => {
    totalRecebido += p.amount || 0;
    const metodo = p.paymentMethod || 'unknown';
    porMetodo[metodo] = (porMetodo[metodo] || 0) + p.amount;
  });
  
  console.log(`   Total: ${payments.length}`);
  console.log(`   💵 Valor Total: R$ ${totalRecebido.toFixed(2)}`);
  Object.entries(porMetodo).forEach(([metodo, valor]) => {
    console.log(`   - ${metodo}: R$ ${valor.toFixed(2)}`);
  });
  console.log();
  
  // 4. RELACIONAMENTOS (verificar consistência)
  console.log('🔗 CONSISTÊNCIA DOS DADOS:\n');
  
  // Verificar appointments sem session
  const appointmentsSemSession = appointments.filter(a => !a.session);
  console.log(`   ⚠️  Appointments sem Session: ${appointmentsSemSession.length}`);
  
  // Verificar sessions sem appointment
  const sessionIds = sessions.map(s => s._id.toString());
  const appointmentsComSession = appointments.filter(a => a.session);
  const sessionsOrfas = [];
  
  for (const session of sessions) {
    const temAppointment = appointments.some(a => 
      a.session && a.session.toString() === session._id.toString()
    );
    if (!temAppointment && session.appointmentId) {
      // Verificar se appointment existe
      const appExiste = await Appointment.findById(session.appointmentId);
      if (!appExiste) {
        sessionsOrfas.push(session);
      }
    }
  }
  
  console.log(`   ⚠️  Sessions órfãs (appointment não existe): ${sessionsOrfas.length}`);
  
  // Verificar appointments com billingType = insurance
  const appointmentsConvenio = appointments.filter(a => a.billingType === 'insurance');
  console.log(`   🏥 Appointments Convênio: ${appointmentsConvenio.length}`);
  
  // Verificar pagamentos sem vínculo com appointment
  const paymentsSemAppointment = payments.filter(p => !p.appointment);
  console.log(`   ⚠️  Pagamentos sem Appointment: ${paymentsSemAppointment.length}`);
  
  console.log();
  
  // 5. RESUMO EXECUTIVO
  console.log(`${'='.repeat(80)}`);
  console.log('📊 RESUMO EXECUTIVO:\n');
  console.log(`   Agendamentos: ${appointments.length}`);
  console.log(`   Sessões: ${sessions.length}`);
  console.log(`   Pagamentos: ${payments.length}`);
  console.log(`   Receita Total: R$ ${totalRecebido.toFixed(2)}`);
  console.log(`   Valor Particular (sessões): R$ ${totalValorParticular.toFixed(2)}`);
  console.log(`   Valor Convênio (sessões): R$ ${totalValorConvenio.toFixed(2)}`);
  console.log();
  console.log(`   ⚠️  Problemas encontrados:`);
  console.log(`       - Appointments sem Session: ${appointmentsSemSession.length}`);
  console.log(`       - Sessions órfãs: ${sessionsOrfas.length}`);
  console.log(`       - Pagamentos sem Appointment: ${paymentsSemAppointment.length}`);
  console.log(`${'='.repeat(80)}\n`);
  
  return {
    appointments: appointments.length,
    sessions: sessions.length,
    payments: payments.length,
    receita: totalRecebido,
    problemas: {
      semSession: appointmentsSemSession.length,
      sessionsOrfas: sessionsOrfas.length,
      pagamentosSemApp: paymentsSemAppointment.length
    }
  };
}

async function main() {
  try {
    await connectDB();
    
    // Auditar Março/2026
    const marco = await auditarPeriodo(2026, 3);
    
    // Auditar Abril/2026
    const abril = await auditarPeriodo(2026, 4);
    
    // Resumo Geral
    console.log('\n' + '='.repeat(80));
    console.log('📊 RESUMO GERAL (MARÇO + ABRIL/2026)');
    console.log('='.repeat(80));
    console.log(`   Agendamentos: ${marco.appointments + abril.appointments}`);
    console.log(`   Sessões: ${marco.sessions + abril.sessions}`);
    console.log(`   Pagamentos: ${marco.payments + abril.payments}`);
    console.log(`   Receita Total: R$ ${(marco.receita + abril.receita).toFixed(2)}`);
    console.log('='.repeat(80));
    
    await mongoose.disconnect();
    console.log('\n✅ Auditoria concluída');
    
  } catch (error) {
    console.error('❌ Erro:', error);
    process.exit(1);
  }
}

main();
