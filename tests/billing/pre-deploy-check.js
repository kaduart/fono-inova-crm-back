#!/usr/bin/env node
/**
 * ============================================================================
 * PRE-DEPLOY CHECK - Billing V2
 * ============================================================================
 * 
 * Verificações obrigatórias antes de subir para produção
 * 
 * Usage: node tests/billing/pre-deploy-check.js
 * ============================================================================
 */

import mongoose from 'mongoose';
import Redis from 'ioredis';
import fs from 'fs';
import path from 'path';

const MONGO_URI = process.env.MONGO_URI;
const REDIS_URL = process.env.REDIS_URL;

const checks = [];

function check(name, test, critical = true) {
  checks.push({ name, test, critical });
}

async function runChecks() {
  console.log('🔍 PRE-DEPLOY CHECK - Billing V2\n');
  console.log('=' .repeat(60));

  // Check 1: Variáveis de ambiente
  check('MONGO_URI definida', () => !!MONGO_URI, true);
  check('REDIS_URL definida', () => !!process.env.REDIS_URL, true);
  check('NODE_ENV definido', () => !!process.env.NODE_ENV, false);

  // Check 2: Conexão MongoDB
  check('MongoDB conecta', async () => {
    try {
      await mongoose.connect(MONGO_URI);
      return true;
    } catch {
      return false;
    }
  }, true);

  // Check 3: Conexão Redis
  check('Redis conecta', async () => {
    try {
      const redis = new Redis(REDIS_URL);
      await redis.ping();
      await redis.quit();
      return true;
    } catch {
      return false;
    }
  }, true);

  // Check 4: Arquivos necessários
  check('Service V2 existe', () => {
    return fs.existsSync(path.join(process.cwd(), 'domains/billing/services/insuranceBillingService.v2.js'));
  }, true);

  check('Worker existe', () => {
    return fs.existsSync(path.join(process.cwd(), 'domains/billing/workers/billingConsumerWorker.js'));
  }, true);

  check('State Machine existe', () => {
    return fs.existsSync(path.join(process.cwd(), 'domains/billing/models/FinancialStateMachine.js'));
  }, true);

  check('Feature Flags existe', () => {
    return fs.existsSync(path.join(process.cwd(), 'domains/billing/config/FeatureFlags.js'));
  }, true);

  check('Reconciliation existe', () => {
    return fs.existsSync(path.join(process.cwd(), 'domains/billing/services/ReconciliationService.js'));
  }, true);

  // Check 5: Índices MongoDB (se conectou)
  if (mongoose.connection.readyState === 1) {
    check('Índice EventStore (idempotencyKey)', async () => {
      const indexes = await mongoose.connection.db.collection('eventstores').indexes();
      return indexes.some(i => i.key.idempotencyKey);
    }, true);

    check('Índice Appointment (source.sessionId)', async () => {
      const indexes = await mongoose.connection.db.collection('appointments').indexes();
      return indexes.some(i => i.key['source.sessionId']);
    }, true);
  }

  // Check 6: Feature Flags inicializadas
  if (mongoose.connection.readyState === 1) {
    check('FeatureFlags collection acessível', async () => {
      const flags = await mongoose.connection.db.collection('featureflags').findOne();
      return true; // Só verifica se consegue acessar
    }, false);
  }

  // Executar checks
  let passed = 0;
  let failed = 0;
  let criticalFailed = 0;

  for (const { name, test, critical } of checks) {
    process.stdout.write(`${critical ? '🔴' : '🟡'} ${name}... `);
    
    try {
      const result = await test();
      if (result) {
        console.log('✅ PASS');
        passed++;
      } else {
        console.log('❌ FAIL');
        failed++;
        if (critical) criticalFailed++;
      }
    } catch (error) {
      console.log(`❌ ERROR: ${error.message}`);
      failed++;
      if (critical) criticalFailed++;
    }
  }

  // Resultado
  console.log('\n' + '=' .repeat(60));
  console.log(`Total: ${checks.length} checks`);
  console.log(`✅ Passaram: ${passed}`);
  console.log(`❌ Falharam: ${failed}`);
  
  if (criticalFailed > 0) {
    console.log(`\n🔴 ${criticalFailed} CRÍTICOS FALHARAM`);
    console.log('NÃO DEPLOYAR até corrigir');
    process.exit(1);
  } else if (failed > 0) {
    console.log('\n🟡 Alguns não-críticos falharam');
    console.log('Revisar, mas pode prosseguir com cautela');
  } else {
    console.log('\n✅ TODOS OS CHECKS PASSARAM');
    console.log('Pronto para deploy!');
  }

  if (mongoose.connection.readyState === 1) {
    await mongoose.disconnect();
  }
}

runChecks().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
