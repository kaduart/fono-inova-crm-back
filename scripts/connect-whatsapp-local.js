#!/usr/bin/env node
/**
 * 🏠 Conecta WhatsApp localmente e exporta sessão para o Render
 *
 * Uso:
 *   node scripts/connect-whatsapp-local.js
 *
 * O script monitora o MongoDB. Quando detecta status "ready",
 * compacta a sessão automaticamente e para.
 */

import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { execSync } from 'child_process';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
const AUTH_DIR = path.resolve(process.cwd(), '.wwebjs_auth');
const SESSION_DIR = path.join(AUTH_DIR, 'session');
const EXPORT_FILE = path.resolve(process.cwd(), 'session-export.tar.gz');

if (!MONGO_URI) {
  console.error('❌ MONGODB_URI não configurada');
  process.exit(1);
}

// Limpa sessão antiga
console.log('🧹 Limpando sessão antiga...');
try {
  if (fs.existsSync(AUTH_DIR)) {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(AUTH_DIR, { recursive: true });
} catch (e) {
  console.error('Erro ao limpar sessão:', e.message);
  process.exit(1);
}

console.log('✅ Sessão limpa. Iniciando WhatsApp...\n');
console.log('📱 INSTRUÇÕES:');
console.log('   1. Escaneie o QR com o celular quando aparecer');
console.log('   2. Espere a sincronização completar');
console.log('   3. Quando vir "✅ SESSÃO EXPORTADA!", está pronto\n');

// Importa modelos
await import('../models/index.js');

// Conecta MongoDB
await mongoose.connect(MONGO_URI, {
  maxPoolSize: 5,
  serverSelectionTimeoutMS: 30000
});
console.log('✅ MongoDB conectado\n');

// Carrega o WhatsApp Web.js service
const { initWhatsAppClient } = await import('../services/whatsappWebJsService.js');

// Inicializa WhatsApp
initWhatsAppClient();

// Monitora o MongoDB pelo status ready
const WhatsAppWebState = mongoose.model('WhatsAppWebState');

const checkInterval = setInterval(async () => {
  try {
    const state = await WhatsAppWebState.findOne({ instanceId: 'main' }).lean();
    if (state && state.status === 'ready') {
      console.log('\n🎉 WhatsApp conectado! Aguardando 5s para estabilizar...');
      clearInterval(checkInterval);

      setTimeout(() => {
        try {
          // Compacta a sessão
          if (fs.existsSync(SESSION_DIR)) {
            execSync(`tar -czf "${EXPORT_FILE}" -C "${AUTH_DIR}" session`, { stdio: 'inherit' });
            console.log('\n✅✅✅ SESSÃO EXPORTADA! ✅✅✅');
            console.log(`📦 Arquivo: ${EXPORT_FILE}`);
            console.log(`📏 Tamanho: ${(fs.statSync(EXPORT_FILE).size / 1024 / 1024).toFixed(2)} MB`);
            console.log('\n📤 PRÓXIMO PASSO:');
            console.log('   1. Vá no Render Dashboard → Shell');
            console.log('   2. Execute: cd /opt/render/project/src');
            console.log('   3. Faça upload do session-export.tar.gz');
            console.log('   4. Execute: tar -xzf session-export.tar.gz');
            console.log('   5. Reinicie o serviço\n');
          } else {
            console.log('\n⚠️ Sessão não encontrada em', SESSION_DIR);
          }
        } catch (e) {
          console.error('\n❌ Erro ao exportar:', e.message);
        }
        process.exit(0);
      }, 5000);
    }
  } catch (e) {
    // ignora erro de polling
  }
}, 3000);

// Timeout de segurança: 15 minutos
setTimeout(() => {
  console.log('\n⏰ Timeout de 15 minutos atingido. Verifique se escaneou o QR.');
  clearInterval(checkInterval);
  process.exit(1);
}, 15 * 60 * 1000);
