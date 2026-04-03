#!/usr/bin/env node
/**
 * ============================================================================
 * LOAD TEST - Billing V2
 * ============================================================================
 * 
 * Simula carga real para validar performance antes do go-live
 * 
 * Usage: node tests/billing/load-test.js [numSessions]
 * ============================================================================
 */

import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { insuranceBillingService } from '../../domains/billing/services/insuranceBillingService.v2.js';
import Session from '../../models/Session.js';
import Payment from '../../models/Payment.js';
import Appointment from '../../models/Appointment.js';
import InsuranceGuide from '../../models/InsuranceGuide.js';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/crm';
const NUM_SESSIONS = parseInt(process.argv[2]) || 10;

async function loadTest() {
  console.log(`🚀 Load Test: ${NUM_SESSIONS} sessões`);
  console.log('Conectando...');
  
  await mongoose.connect(MONGO_URI);
  
  const Patient = mongoose.model('Patient');
  const Professional = mongoose.model('Professional');
  
  // Setup
  const patient = await Patient.create({ 
    fullName: `Load Test ${Date.now()}`, 
    cpf: String(Math.floor(Math.random() * 100000000000)).padStart(11, '0')
  });
  
  const professional = await Professional.create({ 
    fullName: 'Prof Load Test', 
    specialty: 'fonoaudiologia' 
  });
  
  const guide = await InsuranceGuide.create({
    number: `LOAD-${uuidv4().slice(0, 8)}`,
    patientId: patient._id,
    specialty: 'fonoaudiologia',
    insurance: 'test-insurance',
    totalSessions: NUM_SESSIONS + 5,
    usedSessions: 0,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  });

  const sessions = [];
  const results = {
    success: 0,
    failed: 0,
    duplicates: 0,
    totalTime: 0,
    minTime: Infinity,
    maxTime: 0
  };

  console.log(`Criando ${NUM_SESSIONS} sessões...`);
  
  // Criar sessões
  for (let i = 0; i < NUM_SESSIONS; i++) {
    const session = await Session.create({
      patient: patient._id,
      professional: professional._id,
      specialty: 'fonoaudiologia',
      date: new Date(),
      time: `${10 + Math.floor(i/2)}:${i % 2 === 0 ? '00' : '30'}`,
      status: 'scheduled',
      paymentType: 'convenio',
      insuranceGuide: guide._id
    });
    sessions.push(session);
  }

  console.log('Processando...\n');

  // Processar em paralelo (simula carga real)
  const startTime = Date.now();
  
  await Promise.all(sessions.map(async (session, index) => {
    const sessionStart = Date.now();
    
    try {
      const result = await insuranceBillingService.processSessionCompleted(
        session._id.toString(),
        { correlationId: `load-${uuidv4()}` }
      );
      
      const sessionTime = Date.now() - sessionStart;
      results.totalTime += sessionTime;
      results.minTime = Math.min(results.minTime, sessionTime);
      results.maxTime = Math.max(results.maxTime, sessionTime);
      
      if (result.duplicate) {
        results.duplicates++;
      } else {
        results.success++;
      }
      
      process.stdout.write(`\rProgresso: ${index + 1}/${NUM_SESSIONS}`);
      
    } catch (error) {
      results.failed++;
      console.error(`\n❌ Erro na sessão ${session._id}:`, error.message);
    }
  }));

  const totalTime = Date.now() - startTime;

  // Verificar duplicatas
  const payments = await Payment.find({ patient: patient._id });
  const appointments = await Appointment.find({ patient: patient._id });
  
  // Check duplicatas por session
  const sessionIds = sessions.map(s => s._id.toString());
  const dupPayments = await Payment.aggregate([
    { $match: { session: { $in: sessions.map(s => s._id) } } } },
    { $group: { _id: '$session', count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } }
  ]);

  // Resultados
  console.log('\n\n' + '='.repeat(60));
  console.log('RESULTADOS DO LOAD TEST');
  console.log('='.repeat(60));
  console.log(`Total de sessões: ${NUM_SESSIONS}`);
  console.log(`Sucessos: ${results.success}`);
  console.log(`Falhas: ${results.failed}`);
  console.log(`Duplicatas (detectadas): ${results.duplicates}`);
  console.log(`Duplicatas reais: ${dupPayments.length}`);
  console.log(`\nTempo total: ${totalTime}ms`);
  console.log(`Tempo médio: ${(results.totalTime / NUM_SESSIONS).toFixed(2)}ms`);
  console.log(`Tempo mínimo: ${results.minTime}ms`);
  console.log(`Tempo máximo: ${results.maxTime}ms`);
  console.log(`Throughput: ${(NUM_SESSIONS / (totalTime / 1000)).toFixed(2)} ops/sec`);
  
  console.log(`\nEntidades criadas:`);
  console.log(`  Payments: ${payments.length}`);
  console.log(`  Appointments: ${appointments.length}`);
  
  const guideFinal = await InsuranceGuide.findById(guide._id);
  console.log(`  Sessões consumidas: ${guideFinal.usedSessions}/${NUM_SESSIONS}`);

  // Validação
  console.log('\n' + '='.repeat(60));
  if (results.failed === 0 && dupPayments.length === 0 && guideFinal.usedSessions === NUM_SESSIONS) {
    console.log('✅ LOAD TEST PASSOU');
    console.log('Sistema pronto para produção');
  } else {
    console.log('❌ LOAD TEST FALHOU');
    console.log('Revisar antes do go-live');
    process.exit(1);
  }

  // Cleanup
  await Session.deleteMany({ patient: patient._id });
  await Payment.deleteMany({ patient: patient._id });
  await Appointment.deleteMany({ patient: patient._id });
  await InsuranceGuide.findByIdAndDelete(guide._id);
  await Patient.findByIdAndDelete(patient._id);
  await Professional.findByIdAndDelete(professional._id);

  await mongoose.disconnect();
}

loadTest().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
