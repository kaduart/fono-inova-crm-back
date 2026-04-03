#!/usr/bin/env node
/**
 * Script de validação do Billing V2
 * Roda antes de cada fase do deploy
 * 
 * Usage: node scripts/validate-billing-v2.js
 */

import mongoose from 'mongoose';
import '../domains/billing/models/FinancialStateMachine.js';

// Conexão
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/crm';

async function validate() {
  await mongoose.connect(MONGO_URI);
  console.log('🔍 Validando Billing V2...\n');

  const db = mongoose.connection.db;
  const issues = [];

  // Check 1: Sessions sem Payment
  console.log('Check 1: Sessions sem Payment...');
  const sessionsWithoutPayment = await db.collection('sessions').find({
    paymentMethod: 'convenio',
    status: { $in: ['completed', 'confirmed'] },
    insuranceBillingProcessed: true
  }).project({ _id: 1, date: 1, patient: 1 }).toArray();

  let count1 = 0;
  for (const session of sessionsWithoutPayment) {
    const payment = await db.collection('payments').findOne({ session: session._id });
    if (!payment) {
      count1++;
      issues.push({
        type: 'SESSION_WITHOUT_PAYMENT',
        severity: 'HIGH',
        sessionId: session._id,
        message: `Session ${session._id} processed but no Payment found`
      });
    }
  }
  console.log(`  ${count1 === 0 ? '✅' : '❌'} Sessions sem Payment: ${count1}\n`);

  // Check 2: Payments duplicados por session
  console.log('Check 2: Payments duplicados...');
  const duplicates = await db.collection('payments').aggregate([
    { $match: { billingType: 'convenio', session: { $exists: true } } },
    { $group: { _id: '$session', count: { $sum: 1 }, ids: { $push: '$_id' } } },
    { $match: { count: { $gt: 1 } } }
  ]).toArray();

  console.log(`  ${duplicates.length === 0 ? '✅' : '❌'} Payments duplicados: ${duplicates.length}`);
  if (duplicates.length > 0) {
    issues.push({
      type: 'DUPLICATE_PAYMENTS',
      severity: 'CRITICAL',
      count: duplicates.length,
      examples: duplicates.slice(0, 3)
    });
  }
  console.log();

  // Check 3: Appointments duplicados
  console.log('Check 3: Appointments duplicados...');
  const dupAppointments = await db.collection('appointments').aggregate([
    { $match: { 'source.type': 'session', 'source.sessionId': { $exists: true } } },
    { $group: { _id: '$source.sessionId', count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } }
  ]).toArray();

  console.log(`  ${dupAppointments.length === 0 ? '✅' : '❌'} Appointments duplicados: ${dupAppointments.length}\n`);
  if (dupAppointments.length > 0) {
    issues.push({
      type: 'DUPLICATE_APPOINTMENTS',
      severity: 'CRITICAL',
      count: dupAppointments.length
    });
  }

  // Check 4: Status divergentes (Payment='paid' mas Session não)
  console.log('Check 4: Status divergentes...');
  const divergent = await db.collection('payments').find({
    billingType: 'convenio',
    status: 'paid'
  }).project({ _id: 1, session: 1, status: 1 }).toArray();

  let count4 = 0;
  for (const payment of divergent) {
    if (!payment.session) continue;
    const session = await db.collection('sessions').findOne({ 
      _id: payment.session 
    }, { projection: { isPaid: 1 } });
    
    if (session && !session.isPaid) {
      count4++;
    }
  }
  console.log(`  ${count4 === 0 ? '✅' : '⚠️'} Status divergentes: ${count4}\n`);

  // Check 5: Guias inconsistentes
  console.log('Check 5: Guias inconsistentes...');
  const guideIssues = await db.collection('insuranceguides').countDocuments({
    $expr: { $ne: ['$usedSessions', { $size: { $ifNull: ['$consumptionHistory', []] } }] }
  });
  console.log(`  ${guideIssues === 0 ? '✅' : '❌'} Guias inconsistentes: ${guideIssues}\n`);

  // Check 6: Payments com valor zerado (não 'pending_billing')
  console.log('Check 6: Payments com valor zerado...');
  const zeroValues = await db.collection('payments').countDocuments({
    billingType: 'convenio',
    status: { $ne: 'pending_billing' },
    $or: [
      { amount: 0 },
      { amount: { $exists: false } }
    ]
  });
  console.log(`  ${zeroValues === 0 ? '✅' : '⚠️'} Payments zerados: ${zeroValues}\n`);

  // Resumo
  console.log('='.repeat(50));
  const critical = issues.filter(i => i.severity === 'CRITICAL').length;
  const high = issues.filter(i => i.severity === 'HIGH').length;

  if (critical > 0) {
    console.log('❌ BLOQUEADO: Problemas CRÍTICOS encontrados');
    process.exit(1);
  } else if (high > 0) {
    console.log('⚠️ ATENÇÃO: Problemas HIGH encontrados, revise antes de continuar');
  } else {
    console.log('✅ TODOS OS CHECKS PASSARAM');
  }

  console.log(`\nTotal de issues: ${issues.length}`);
  if (issues.length > 0) {
    console.log('\nDetalhes:');
    issues.forEach(i => console.log(`  [${i.severity}] ${i.type}: ${i.message || i.count}`));
  }

  await mongoose.disconnect();
}

validate().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
