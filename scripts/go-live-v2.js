#!/usr/bin/env node
/**
 * GO-LIVE GRADUAL - Billing V2
 * Script interativo para ativar o V2 por fases
 * 
 * Usage: node scripts/go-live-v2.js [fase]
 * Fases: worker | create | billed | received | all
 */

import mongoose from 'mongoose';
import { execSync } from 'child_process';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/crm';

const PHASES = {
  worker: {
    flag: 'USE_V2_WORKER',
    description: 'Ativa worker BullMQ',
    validation: 'validate-worker'
  },
  create: {
    flag: 'USE_V2_BILLING_CREATE',
    description: 'Ativa criação de Appointment/Payment',
    validation: 'validate-billing'
  },
  billed: {
    flag: 'USE_V2_BILLING_BILLED',
    description: 'Ativa processamento de faturamento',
    validation: 'validate-billing'
  },
  received: {
    flag: 'USE_V2_BILLING_RECEIVED',
    description: 'Ativa processamento de recebimento',
    validation: 'validate-billing'
  }
};

async function setFlag(db, flag, enabled) {
  await db.collection('featureflags').updateOne(
    { key: flag },
    { 
      $set: { 
        enabled, 
        updatedAt: new Date(),
        updatedBy: `go-live-script-${process.env.USER || 'unknown'}`
      },
      $setOnInsert: { description: PHASES[Object.keys(PHASES).find(k => PHASES[k].flag === flag)].description }
    },
    { upsert: true }
  );
}

async function getFlagStatus(db, flag) {
  const doc = await db.collection('featureflags').findOne({ key: flag });
  return doc?.enabled || false;
}

async function validatePhase(phase) {
  console.log(`\n🔍 Validando ${phase}...`);
  try {
    execSync('node scripts/validate-billing-v2.js', { stdio: 'inherit' });
    return true;
  } catch (err) {
    console.log(`\n❌ Validação falhou para ${phase}`);
    return false;
  }
}

async function goLive(phase) {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  console.log('🚀 GO-LIVE BILLING V2');
  console.log('=' .repeat(60));

  if (phase === 'all') {
    // Ativa tudo em sequência
    for (const [key, config] of Object.entries(PHASES)) {
      console.log(`\n📦 Fase: ${key.toUpperCase()}`);
      console.log(`   ${config.description}`);
      
      const current = await getFlagStatus(db, config.flag);
      if (current) {
        console.log('   ℹ️  Já está ativo');
        continue;
      }

      // Valida antes
      if (!await validatePhase(key)) {
        console.log('   ⛔ BLOQUEADO: Validação falhou');
        continue;
      }

      // Ativa
      await setFlag(db, config.flag, true);
      console.log('   ✅ ATIVADO');
      
      // Aguarda se não for a última
      if (key !== 'received') {
        console.log('   ⏳ Aguardando 30s para estabilizar...');
        await new Promise(r => setTimeout(r, 30000));
      }
    }
  } else if (PHASES[phase]) {
    // Ativa fase específica
    const config = PHASES[phase];
    console.log(`📦 Fase: ${phase.toUpperCase()}`);
    console.log(`   ${config.description}`);

    const current = await getFlagStatus(db, config.flag);
    if (current) {
      console.log('ℹ️  Já está ativo');
      return;
    }

    if (!await validatePhase(phase)) {
      console.log('⛔ BLOQUEADO: Validação falhou');
      return;
    }

    await setFlag(db, config.flag, true);
    console.log('✅ ATIVADO');
  } else {
    console.log('❌ Fase inválida');
    console.log('\nFases disponíveis:');
    Object.keys(PHASES).forEach(k => console.log(`  - ${k}`));
    console.log('  - all (ativa todas sequencialmente)');
  }

  // Status final
  console.log('\n' + '=' .repeat(60));
  console.log('STATUS DAS FLAGS:');
  for (const [key, config] of Object.entries(PHASES)) {
    const status = await getFlagStatus(db, config.flag);
    console.log(`  ${status ? '✅' : '❌'} ${config.flag}: ${status ? 'ATIVO' : 'DESATIVADO'}`);
  }

  await mongoose.disconnect();
}

const phase = process.argv[2];

if (!phase) {
  console.log('Usage: node scripts/go-live-v2.js [fase]');
  console.log('\nFases:');
  console.log('  worker   - Ativa worker BullMQ');
  console.log('  create   - Ativa criação Appointment/Payment');
  console.log('  billed   - Ativa faturamento');
  console.log('  received - Ativa recebimento');
  console.log('  all      - Ativa todas em sequência');
  process.exit(0);
}

goLive(phase).catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
