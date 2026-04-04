#!/usr/bin/env node
/**
 * 🔍 DIAGNÓSTICO V2 - DIA 01/04/2026
 * 
 * Verifica:
 * 1. Agendamentos do dia (appointments)
 * 2. Sessões criadas (sessions)
 * 3. Pagamentos registrados (payments) 
 * 4. Convênios e Liminares
 * 5. Consistência V1 vs V2
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';
import PatientBalance from '../models/PatientBalance.js';
import Package from '../models/Package.js';

dotenv.config();

const DATA_ALVO = '2026-04-01';

async function diagnostico() {
  try {
    console.log('🔗 Conectando ao MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Conectado!\n');

    console.log('='.repeat(80));
    console.log(`📅 DIAGNÓSTICO COMPLETO: ${DATA_ALVO}`);
    console.log('='.repeat(80));

    // 1. AGENDAMENTOS DO DIA
    console.log('\n📋 1. AGENDAMENTOS (Appointments)');
    console.log('-'.repeat(80));
    
    const startDate = new Date(`${DATA_ALVO}T00:00:00-03:00`);
    const endDate = new Date(`${DATA_ALVO}T23:59:59-03:00`);
    
    const appointments = await Appointment.find({
      date: { $gte: startDate, $lte: endDate }
    }).populate('patient', 'fullName').populate('doctor', 'fullName').populate('session').populate('payment').lean();

    console.log(`   Total: ${appointments.length} agendamentos`);
    
    let convenioCount = 0;
    let liminarCount = 0;
    let particularCount = 0;
    let pacoteCount = 0;
    let problemaCount = 0;

    appointments.forEach((apt, i) => {
      const isConvenio = apt.billingType === 'convenio' || apt.insuranceProvider;
      const isLiminar = apt.billingType === 'liminar' || (apt.notes && apt.notes.toLowerCase().includes('liminar'));
      const isPacote = apt.serviceType === 'package_session' || apt.package;
      
      if (isConvenio) convenioCount++;
      else if (isLiminar) liminarCount++;
      else if (isPacote) pacoteCount++;
      else particularCount++;

      // Verifica problemas
      const problemas = [];
      if (apt.operationalStatus === 'completed' && !apt.session) {
        problemas.push('❌ Completado mas SEM SESSÃO');
      }
      if (apt.operationalStatus === 'completed' && apt.paymentStatus === 'pending' && !isConvenio && !isLiminar) {
        problemas.push('❌ Completado mas PAGAMENTO PENDENTE (não convênio)');
      }
      if (isConvenio && !apt.insuranceGuideId && !apt.authorizationCode) {
        problemas.push('⚠️ Convênio sem guia/autorização');
      }
      
      if (problemas.length > 0) problemaCount++;

      console.log(`\n   ${i+1}. ${apt.patient?.fullName || 'Sem paciente'} - ${apt.time}`);
      console.log(`       Status: ${apt.operationalStatus} | Pagamento: ${apt.paymentStatus}`);
      console.log(`       Tipo: ${isConvenio ? '🏥 CONVÊNIO' : isLiminar ? '⚖️ LIMINAR' : isPacote ? '📦 PACOTE' : '💵 PARTICULAR'}`);
      console.log(`       Valor: R$ ${apt.sessionValue || apt.paymentAmount || 0}`);
      if (apt.session) console.log(`       ✅ Session vinculada: ${apt.session._id}`);
      if (apt.payment) console.log(`       ✅ Payment vinculado: ${apt.payment._id}`);
      problemas.forEach(p => console.log(`       ${p}`));
    });

    console.log('\n   RESUMO POR TIPO:');
    console.log(`   💵 Particular: ${particularCount}`);
    console.log(`   📦 Pacote: ${pacoteCount}`);
    console.log(`   🏥 Convênio: ${convenioCount}`);
    console.log(`   ⚖️ Liminar: ${liminarCount}`);
    if (problemaCount > 0) console.log(`   🚨 Com problemas: ${problemaCount}`);

    // 2. SESSÕES DO DIA
    console.log('\n\n📋 2. SESSÕES (Sessions)');
    console.log('-'.repeat(80));
    
    const sessions = await Session.find({
      date: { $gte: startDate, $lte: endDate }
    }).populate('patient', 'fullName').populate('doctor', 'fullName').lean();

    console.log(`   Total: ${sessions.length} sessões`);
    
    let sessoesComPagamento = 0;
    let sessoesSemPagamento = 0;
    let sessoesConvenio = 0;

    sessions.forEach((sess, i) => {
      const temPagamento = sess.isPaid || sess.paymentStatus === 'paid';
      const isConvenio = sess.paymentMethod === 'convenio';
      
      if (temPagamento) sessoesComPagamento++;
      else sessoesSemPagamento++;
      if (isConvenio) sessoesConvenio++;

      if (i < 10) { // Só mostra primeiros 10
        console.log(`\n   ${i+1}. ${sess.patient?.fullName || 'Sem paciente'} - ${sess.time}`);
        console.log(`       Status: ${sess.status} | Pago: ${temPagamento ? '✅' : '❌'}`);
        console.log(`       Método: ${sess.paymentMethod || 'N/A'}`);
        console.log(`       Valor: R$ ${sess.sessionValue || 0}`);
      }
    });
    
    if (sessions.length > 10) console.log(`\n   ... e mais ${sessions.length - 10} sessões`);
    
    console.log('\n   RESUMO:');
    console.log(`   ✅ Com pagamento: ${sessoesComPagamento}`);
    console.log(`   ❌ Sem pagamento: ${sessoesSemPagamento}`);
    console.log(`   🏥 Convênio: ${sessoesConvenio}`);

    // 3. PAGAMENTOS DO DIA
    console.log('\n\n📋 3. PAGAMENTOS (Payments)');
    console.log('-'.repeat(80));
    
    const payments = await Payment.find({
      $or: [
        { paymentDate: { $gte: startDate, $lte: endDate } },
        { serviceDate: { $gte: startDate, $lte: endDate } },
        { createdAt: { $gte: startDate, $lte: endDate }, status: 'paid' }
      ]
    }).populate('patient', 'fullName').populate('appointment').lean();

    console.log(`   Total: ${payments.length} pagamentos`);
    
    let totalCaixa = 0;
    let totalConvenioPag = 0;
    let totalPendente = 0;

    payments.forEach((pay, i) => {
      if (pay.status === 'paid') {
        if (pay.billingType === 'convenio' || pay.paymentMethod === 'convenio') {
          totalConvenioPag += pay.amount;
        } else {
          totalCaixa += pay.amount;
        }
      } else {
        totalPendente += pay.amount;
      }

      if (i < 10) {
        console.log(`\n   ${i+1}. ${pay.patient?.fullName || 'Sem paciente'} - R$ ${pay.amount}`);
        console.log(`       Status: ${pay.status}`);
        console.log(`       Tipo: ${pay.billingType || pay.paymentMethod || 'N/A'}`);
        console.log(`       Data pagamento: ${pay.paymentDate || 'N/A'}`);
      }
    });
    
    if (payments.length > 10) console.log(`\n   ... e mais ${payments.length - 10} pagamentos`);
    
    console.log('\n   RESUMO FINANCEIRO:');
    console.log(`   💵 Caixa (particular): R$ ${totalCaixa.toFixed(2)}`);
    console.log(`   🏥 Convênio: R$ ${totalConvenioPag.toFixed(2)}`);
    console.log(`   ⏳ Pendente: R$ ${totalPendente.toFixed(2)}`);

    // 4. VERIFICAÇÃO DE CONSISTÊNCIA
    console.log('\n\n📋 4. VERIFICAÇÃO DE CONSISTÊNCIA V1 vs V2');
    console.log('-'.repeat(80));
    
    // Agendamentos completados sem sessão
    const completadosSemSessao = appointments.filter(a => 
      a.operationalStatus === 'completed' && !a.session
    );
    
    // Agendamentos completados sem pagamento (exceto convênio/liminar)
    const completadosSemPagamento = appointments.filter(a => 
      a.operationalStatus === 'completed' && 
      a.paymentStatus === 'pending' &&
      a.billingType !== 'convenio' &&
      a.billingType !== 'liminar' &&
      !a.package
    );
    
    // Sessões sem appointment vinculado
    const sessoesOrfas = sessions.filter(s => !s.appointmentId);
    
    console.log(`   🚨 Agendamentos completados SEM SESSÃO: ${completadosSemSessao.length}`);
    console.log(`   🚨 Agendamentos completados SEM PAGAMENTO: ${completadosSemPagamento.length}`);
    console.log(`   🚨 Sessões órfãs (sem appointment): ${sessoesOrfas.length}`);

    if (completadosSemSessao.length > 0) {
      console.log('\n   Detalhes - Completados sem sessão:');
      completadosSemSessao.forEach(a => {
        console.log(`   - ${a.patient?.fullName} às ${a.time} (${a.billingType || 'particular'})`);
      });
    }

    // 5. RESUMO FINAL
    console.log('\n\n' + '='.repeat(80));
    console.log('📊 RESUMO FINAL DO DIA 01/04/2026');
    console.log('='.repeat(80));
    console.log(`   Total Agendamentos: ${appointments.length}`);
    console.log(`   Total Sessões: ${sessions.length}`);
    console.log(`   Total Pagamentos: ${payments.length}`);
    console.log(`   Entrada em Caixa: R$ ${totalCaixa.toFixed(2)}`);
    console.log(`   Problemas encontrados: ${completadosSemSessao.length + completadosSemPagamento.length + sessoesOrfas.length}`);
    
    if (completadosSemSessao.length === 0 && completadosSemPagamento.length === 0) {
      console.log('\n   ✅ TUDO OK! Fluxo V2 funcionando corretamente.');
    } else {
      console.log('\n   ⚠️ HÁ PROBLEMAS que precisam de correção.');
    }

    await mongoose.disconnect();
    console.log('\n✅ Desconectado');
    
  } catch (error) {
    console.error('❌ Erro:', error);
    process.exit(1);
  }
}

diagnostico();
