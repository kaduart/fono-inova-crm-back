#!/usr/bin/env node
/**
 * Status rápido do Billing V2
 * Mostra o que está ativo e se está funcionando
 */

import mongoose from 'mongoose';
import Redis from 'ioredis';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/crm';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

async function status() {
  console.log('📊 STATUS BILLING V2\n');
  
  await mongoose.connect(MONGO_URI);
  const redis = new Redis(REDIS_URL);
  const db = mongoose.connection.db;

  // Feature Flags
  console.log('🎛️  FEATURE FLAGS:');
  const flags = await db.collection('featureflags').find({}).toArray();
  const flagStatus = {
    USE_V2_WORKER: false,
    USE_V2_BILLING_CREATE: false,
    USE_V2_BILLING_BILLED: false,
    USE_V2_BILLING_RECEIVED: false
  };
  
  flags.forEach(f => {
    if (flagStatus[f.key] !== undefined) {
      flagStatus[f.key] = f.enabled;
    }
  });
  
  Object.entries(flagStatus).forEach(([key, enabled]) => {
    console.log(`   ${enabled ? '🟢' : '🔴'} ${key.replace('USE_V2_', '')}`);
  });

  // Worker
  console.log('\n⚙️  WORKER:');
  const queueLength = await redis.llen('bull:billing-orchestrator:wait');
  const dlqLength = await redis.llen('bull:billing-dlq:wait');
  console.log(`   📥 Fila principal: ${queueLength} jobs`);
  console.log(`   💀 DLQ: ${dlqLength} jobs ${dlqLength > 0 ? '⚠️' : ''}`);

  // Últimos eventos
  console.log('\n📈 ÚLTIMAS 1H:');
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  
  const events = await db.collection('eventstores').aggregate([
    { $match: { aggregateType: 'InsuranceBilling', createdAt: { $gte: oneHourAgo } } },
    { $group: { _id: '$eventType', count: { $sum: 1 } } }
  ]).toArray();
  
  if (events.length === 0) {
    console.log('   Nenhum evento processado');
  } else {
    events.forEach(e => {
      console.log(`   ${e._id}: ${e.count}`);
    });
  }

  // Inconsistências (rápido)
  console.log('\n🔍 INCONSISTÊNCIAS:');
  const orphanSessions = await db.collection('sessions').countDocuments({
    insuranceBillingProcessed: true,
    paymentType: 'convenio'
  });
  
  const orphanCheck = await db.collection('payments').countDocuments({
    billingType: 'convenio',
    createdAt: { $gte: oneHourAgo }
  });
  
  console.log(`   Sessions processadas (1h): ${orphanSessions}`);
  console.log(`   Payments criados (1h): ${orphanCheck}`);
  
  if (orphanSessions !== orphanCheck) {
    console.log('   ⚠️  Diferença detectada - rodar validate');
  } else {
    console.log('   ✅ OK');
  }

  // Resumo
  console.log('\n' + '='.repeat(50));
  const v2Active = flagStatus.USE_V2_BILLING_CREATE || 
                   flagStatus.USE_V2_BILLING_BILLED || 
                   flagStatus.USE_V2_BILLING_RECEIVED;
  
  if (v2Active) {
    console.log('🟢 V2 ESTÁ ATIVO');
  } else {
    console.log('🔴 V2 ESTÁ DESATIVADO (usando legado)');
  }
  
  if (dlqLength > 0) {
    console.log('⚠️  ATENÇÃO: DLQ tem jobs falhos');
  }

  await mongoose.disconnect();
  await redis.quit();
}

status().catch(console.error);
