#!/usr/bin/env node
/**
 * ROLLBACK DE EMERGÊNCIA - Billing V2
 * Desativa todas as flags do V2 imediatamente
 * 
 * Usage: node scripts/rollback-v2-emergency.js
 */

import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/crm';

async function rollback() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  console.log('🚨 ROLLBACK DE EMERGÊNCIA - BILLING V2');
  console.log('Timestamp:', new Date().toISOString());
  console.log('=' .repeat(60));

  // Desativa todas as flags
  const result = await db.collection('featureflags').updateMany(
    { 
      key: { 
        $in: [
          'USE_V2_BILLING_CREATE',
          'USE_V2_BILLING_BILLED',
          'USE_V2_BILLING_RECEIVED',
          'USE_V2_WORKER',
          'USE_V2_RECONCILIATION'
        ]
      }
    },
    { 
      $set: { 
        enabled: false, 
        updatedAt: new Date(),
        updatedBy: 'emergency_rollback_script'
      }
    }
  );

  console.log(`Flags desativadas: ${result.modifiedCount}`);

  // Registra o rollback no log
  await db.collection('rollbacklogs').insertOne({
    timestamp: new Date(),
    type: 'emergency',
    flagsAffected: [
      'USE_V2_BILLING_CREATE',
      'USE_V2_BILLING_BILLED',
      'USE_V2_BILLING_RECEIVED',
      'USE_V2_WORKER',
      'USE_V2_RECONCILIATION'
    ],
    reason: process.env.ROLLBACK_REASON || 'manual_trigger'
  });

  console.log('\n✅ ROLLBACK CONCLUÍDO');
  console.log('\nPróximos passos:');
  console.log('  1. Verificar se legado assumiu controle');
  console.log('  2. Verificar filas (devem estar paradas)');
  console.log('  3. Investigar causa do problema');
  console.log('  4. Corrigir antes de reativar V2');

  // Verifica status atual
  const flags = await db.collection('featureflags').find({
    key: { $in: ['USE_V2_BILLING_CREATE', 'USE_V2_BILLING_BILLED', 'USE_V2_BILLING_RECEIVED'] }
  }).toArray();

  console.log('\nStatus atual das flags:');
  flags.forEach(f => {
    console.log(`  ${f.key}: ${f.enabled ? '✅ ATIVA' : '❌ DESATIVADA'}`);
  });

  await mongoose.disconnect();
}

console.log('⚠️  Isso vai desativar o Billing V2 imediatamente.\n');

// Confirmação
if (process.env.FORCE_ROLLBACK === 'true') {
  rollback().catch(err => {
    console.error('Erro no rollback:', err);
    process.exit(1);
  });
} else {
  console.log('Para confirmar, execute:');
  console.log('  FORCE_ROLLBACK=true node scripts/rollback-v2-emergency.js\n');
  process.exit(0);
}
