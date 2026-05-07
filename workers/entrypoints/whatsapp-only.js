#!/usr/bin/env node
/**
 * 🆘 WhatsApp ONLY — Modo emergência
 * Sobe APENAS o WhatsApp Web. Zero workers. Zero concorrência.
 * Use quando precisar conectar o QR com o mínimo de RAM possível.
 */

import http from 'http';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import '../../models/index.js';
import { initWhatsAppClient, gracefulShutdownWhatsApp, getStatus } from '../../services/whatsappWebJsService.js';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

if (!MONGO_URI) {
    console.error('❌ MONGODB_URI não configurada');
    process.exit(1);
}

// 🛡️ ProtocolError não mata o processo
process.on('uncaughtException', async (err) => {
  console.error('[FATAL]', err.message);
  if (err.message && err.message.includes('ProtocolError')) {
    try { await gracefulShutdownWhatsApp(); } catch (e) {}
    console.log('[FATAL] WhatsApp destruído. Aguardando...');
    return;
  }
  process.exit(1);
});

async function main() {
    try {
        console.log('🆘 MODO EMERGÊNCIA: WhatsApp ONLY\n');

        await mongoose.connect(MONGO_URI, {
            maxPoolSize: 5,
            minPoolSize: 1,
            serverSelectionTimeoutMS: 30000
        });
        console.log('✅ MongoDB conectado\n');

        await initWhatsAppClient();
        console.log('🟢 WhatsApp Web inicializado\n');

        // Health check
        const PORT = process.env.PORT || process.env.WORKER_PORT || 10000;
        const server = http.createServer(async (req, res) => {
            if (req.url === '/api/health') {
                const wa = await getStatus().catch(() => ({ status: 'unknown' }));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'ok',
                    mode: 'whatsapp-only',
                    whatsapp: wa.status,
                    timestamp: new Date().toISOString()
                }));
                return;
            }
            res.writeHead(404); res.end();
        });
        server.listen(PORT, () => {
            console.log(`📊 Health Check: http://localhost:${PORT}/api/health`);
        });

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

process.on('SIGTERM', async () => {
    console.log('\n🛑 SIGTERM...');
    await gracefulShutdownWhatsApp();
    await mongoose.disconnect();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('\n🛑 SIGINT...');
    await gracefulShutdownWhatsApp();
    await mongoose.disconnect();
    process.exit(0);
});

main();
