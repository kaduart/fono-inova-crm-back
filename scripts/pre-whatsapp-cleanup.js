#!/usr/bin/env node
/**
 * 🧹 Script de limpeza PRÉ-DEPLOY do WhatsApp
 *
 * Execute ANTES de fazer deploy das correções:
 * 1. Limpa lock Redis (caso esteja preso)
 * 2. Limpa sessão RemoteAuth corrompida no MongoDB
 * 3. Limpa estado stale no MongoDB
 *
 * Uso:
 *   node scripts/pre-whatsapp-cleanup.js
 */

import mongoose from 'mongoose';
import { safeRedis } from '../config/redisConnection.js';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

async function main() {
  console.log('🧹 Iniciando limpeza pré-deploy do WhatsApp...\n');

  // 1. 🔓 Limpa lock Redis
  console.log('🔍 1. Verificando lock Redis...');
  try {
    const lockExists = await safeRedis.get('lock:whatsapp:init');
    if (lockExists) {
      await safeRedis.del('lock:whatsapp:init');
      console.log('   ✅ Lock "lock:whatsapp:init" removido do Redis.');
    } else {
      console.log('   ℹ️  Lock não encontrado (já estava limpo).');
    }
  } catch (err) {
    console.warn('   ⚠️  Erro ao limpar lock Redis:', err.message);
  }

  // 2. 🗑️ Limpa sessão RemoteAuth no MongoDB
  console.log('\n🔍 2. Conectando ao MongoDB para limpar sessão...');
  if (!MONGO_URI) {
    console.error('❌ MONGODB_URI não configurada!');
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI, {
    serverSelectionTimeoutMS: 10000,
  });
  console.log('   ✅ MongoDB conectado.');

  const db = mongoose.connection.db;

  // Collections usadas pelo wwebjs-mongo (RemoteAuth)
  const collections = await db.listCollections().toArray();
  const collectionNames = collections.map((c) => c.name);

  // RemoteAuth salva em coleções com prefixo do clientId
  const targetCollections = collectionNames.filter(
    (name) =>
      name.includes('wwebjs_auth') ||
      name.includes('fono-inova-main')
  );

  if (targetCollections.length > 0) {
    console.log(`   🗑️  Collections encontradas: ${targetCollections.join(', ')}`);
    for (const collName of targetCollections) {
      try {
        await db.collection(collName).deleteMany({});
        console.log(`   ✅ ${collName} limpa.`);
      } catch (err) {
        console.warn(`   ⚠️  Erro ao limpar ${collName}:`, err.message);
      }
    }
  } else {
    console.log('   ℹ️  Nenhuma collection do RemoteAuth encontrada (já estava limpa).');
  }

  // 3. 🗑️ Limpa estado stale
  console.log('\n🔍 3. Limpando estado stale (WhatsAppWebState)...');
  try {
    const result = await db.collection('whatsappwebstates').deleteMany({ instanceId: 'main' });
    console.log(`   ✅ ${result.deletedCount} documento(s) removido(s) de whatsappwebstates.`);
  } catch (err) {
    console.warn('   ⚠️  Erro ao limpar whatsappwebstates:', err.message);
  }

  await mongoose.disconnect();

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ LIMPEZA CONCLUÍDA');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('Próximos passos:');
  console.log('1. No Render Dashboard: desligue QUALQUER serviço que rode "startWorkers.js"');
  console.log('2. Deixe APENAS o "crm-worker-whatsapp" rodando whatsapp-worker.js');
  console.log('3. Faça o deploy das correções');
  console.log('4. Escanie o QR UMA vez');
  console.log('5. Aguarde "ready: true"');
  console.log('6. Faça Manual Restart e valide se volta a "ready" SEM novo QR');
  console.log('');
}

main().catch((err) => {
  console.error('❌ Erro fatal:', err);
  process.exit(1);
});
