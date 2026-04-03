#!/usr/bin/env node
/**
 * Monitoramento contínuo do Billing V2
 * Roda a cada X minutos via cron
 * 
 * Usage: node scripts/monitor-billing-v2.js
 */

import mongoose from 'mongoose';
import Redis from 'ioredis';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/crm';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

async function monitor() {
  await mongoose.connect(MONGO_URI);
  const redis = new Redis(REDIS_URL);
  const db = mongoose.connection.db;

  console.log('📊 Monitoramento Billing V2', new Date().toISOString());
  console.log('=' .repeat(60));

  // Métrica 1: Taxa de sucesso (última hora)
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const eventsLastHour = await db.collection('eventstores').countDocuments({
    aggregateType: 'InsuranceBilling',
    createdAt: { $gte: oneHourAgo }
  });
  const failedEvents = await db.collection('eventstores').countDocuments({
    aggregateType: 'InsuranceBilling',
    status: 'failed',
    createdAt: { $gte: oneHourAgo }
  });
  const successRate = eventsLastHour > 0 
    ? ((eventsLastHour - failedEvents) / eventsLastHour * 100).toFixed(1)
    : 100;
  
  console.log(`Taxa de sucesso (1h): ${successRate}%`);
  console.log(`  Eventos processados: ${eventsLastHour}`);
  console.log(`  Falhas: ${failedEvents}`);
  console.log(`  ${successRate >= 99 ? '✅' : successRate >= 95 ? '⚠️' : '❌'} ${successRate >= 99 ? 'OK' : 'ATENÇÃO'}\n`);

  // Métrica 2: DLQ (fila de morte)
  const dlqLength = await redis.llen('bull:billing-dlq:wait');
  console.log(`DLQ (jobs falhos): ${dlqLength}`);
  console.log(`  ${dlqLength === 0 ? '✅' : dlqLength < 5 ? '⚠️' : '❌'} ${dlqLength === 0 ? 'Vazia' : 'Pendências'}\n`);

  // Métrica 3: Fila principal
  const queueLength = await redis.llen('bull:billing-orchestrator:wait');
  console.log(`Fila principal: ${queueLength} jobs`);
  console.log(`  ${queueLength < 100 ? '✅' : queueLength < 1000 ? '⚠️' : '❌'} ${queueLength < 100 ? 'Normal' : 'Acumulando'}\n`);

  // Métrica 4: Duplicatas (últimas 24h)
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const dupPayments = await db.collection('payments').aggregate([
    { $match: { billingType: 'convenio', createdAt: { $gte: yesterday } } },
    { $group: { _id: '$session', count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } }
  ]).toArray();
  console.log(`Duplicatas (24h): ${dupPayments.length}`);
  console.log(`  ${dupPayments.length === 0 ? '✅' : '❌'} ${dupPayments.length === 0 ? 'Nenhuma' : 'DETECTADA'}\n`);

  // Métrica 5: Inconsistências de status
  const statusMismatch = await db.collection('payments').countDocuments({
    billingType: 'convenio',
    status: 'paid',
    'insurance.status': { $ne: 'received' }
  });
  console.log(`Inconsistências Payment/Insurance: ${statusMismatch}`);
  console.log(`  ${statusMismatch === 0 ? '✅' : '❌'}\n`);

  // Métrica 6: Processamento por hora
  const hourly = await db.collection('eventstores').aggregate([
    { 
      $match: { 
        aggregateType: 'InsuranceBilling',
        createdAt: { $gte: yesterday }
      } 
    },
    {
      $group: {
        _id: { $hour: '$createdAt' },
        count: { $sum: 1 }
      }
    },
    { $sort: { _id: 1 } }
  ]).toArray();
  
  console.log('Processamento por hora (últimas 24h):');
  hourly.slice(-6).forEach(h => {
    console.log(`  ${String(h._id).padStart(2, '0')}h: ${h.count} eventos`);
  });
  console.log();

  // Alertas
  const alerts = [];
  if (successRate < 95) alerts.push('🚨 Taxa de sucesso < 95%');
  if (dlqLength > 5) alerts.push('🚨 DLQ acumulando');
  if (dupPayments.length > 0) alerts.push('🚨 DUPLICATAS DETECTADAS');
  if (statusMismatch > 0) alerts.push('🚨 Inconsistências de status');

  if (alerts.length > 0) {
    console.log('ALERTAS:');
    alerts.forEach(a => console.log(`  ${a}`));
  } else {
    console.log('✅ Sistema saudável');
  }

  await mongoose.disconnect();
  await redis.disconnect();
}

monitor().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
