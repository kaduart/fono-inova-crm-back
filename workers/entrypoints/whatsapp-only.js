#!/usr/bin/env node
/**
 * 🆘 WhatsApp ONLY — Modo emergência
 * Sobe APENAS o WhatsApp Web. Zero workers. Zero concorrência.
 * Use quando precisar conectar o QR com o mínimo de RAM possível.
 */

import http from 'http';
import path from 'path';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import '../../models/index.js';
import { initWhatsAppClient, getStatus } from '../../services/whatsappWebJsService.js';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

if (!MONGO_URI) {
    console.error('❌ MONGODB_URI não configurada');
    process.exit(1);
}

// 🛡️ Erros não tratados não matam o processo
process.on('uncaughtException', (err) => {
  console.error('[FATAL]', err.message);
  if (err.message && err.message.includes('ProtocolError')) {
    console.log('[FATAL] ProtocolError ignorado. Aguardando estabilizar...');
    return;
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED]', typeof reason === 'string' ? reason : (reason?.message || reason));
  // NÃO sai do processo — deixa o WhatsApp tentar se recuperar
});

async function main() {
    try {
        console.log('🆘 MODO EMERGÊNCIA: WhatsApp ONLY\n');
        console.log(`📂 CWD: ${process.cwd()}`);
        console.log(`📂 Sessão path: ${path.resolve(process.cwd(), '.wwebjs_auth')}\n`);

        await mongoose.connect(MONGO_URI, {
            maxPoolSize: 5,
            minPoolSize: 1,
            serverSelectionTimeoutMS: 30000
        });
        console.log('✅ MongoDB conectado\n');

        // Health check SOBE PRIMEIRO — antes de bloquear no WhatsApp sync
        const PORT = process.env.PORT || process.env.WORKER_PORT || 10000;
        // Health check SÍNCRONO — responde imediatamente, mesmo durante sync pesado
        let lastKnownStatus = 'initializing';
        const server = http.createServer((req, res) => {
            if (req.url === '/api/health' || req.url === '/') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'ok',
                    mode: 'whatsapp-only',
                    whatsapp: lastKnownStatus,
                    timestamp: new Date().toISOString()
                }));
                return;
            }
            res.writeHead(404); res.end();
        });

        // Atualiza status conhecido a cada 10s sem bloquear o health check
        setInterval(async () => {
            try {
                const wa = await getStatus().catch(() => ({ status: 'unknown' }));
                lastKnownStatus = wa.status;
            } catch {}
        }, 10000);
        server.listen(PORT, () => {
            console.log(`📊 Health Check: http://localhost:${PORT}/api/health`);
        });

        // Agora sim inicializa o WhatsApp — o health check já está respondendo
        await initWhatsAppClient();
        console.log('🟢 WhatsApp Web inicializado\n');

        // Log de memória a cada 30s
        setInterval(() => {
            const mem = process.memoryUsage();
            console.log(`[MEMORY] RSS: ${Math.round(mem.rss/1024/1024)}MB | Heap: ${Math.round(mem.heapUsed/1024/1024)}MB`);
        }, 30000);

    } catch (error) {
        console.error('❌ Erro fatal:', error.message);
        process.exit(1);
    }
}

process.on('SIGTERM', () => {
    console.log('\n🛑 SIGTERM recebido. Deixando Render matar o processo naturalmente.');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('\n🛑 SIGINT recebido. Saindo sem tocar no cliente.');
    process.exit(0);
});

main();
