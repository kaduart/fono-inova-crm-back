#!/usr/bin/env node
/**
 * 👶 WhatsApp Child Process
 * Roda APENAS o WhatsApp Web.js. Isolado do processo principal.
 * Se morrer (OOM, crash), o processo pai reinicia automaticamente.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import '../../models/index.js';
import { initWhatsAppClient } from '../../services/whatsappWebJsService.js';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

if (!MONGO_URI) {
    console.error('[CHILD] ❌ MONGODB_URI não configurada');
    process.exit(1);
}

process.on('uncaughtException', (err) => {
    console.error('[CHILD FATAL]', err.message);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error('[CHILD UNHANDLED]', typeof reason === 'string' ? reason : (reason?.message || reason));
});

async function main() {
    console.log('[CHILD] 🚀 Iniciando WhatsApp child process...');

    await mongoose.connect(MONGO_URI, {
        maxPoolSize: 3,
        serverSelectionTimeoutMS: 30000
    });
    console.log('[CHILD] ✅ MongoDB conectado');

    // Avisa o pai que está pronto
    if (process.send) process.send({ type: 'ready_to_init' });

    // Inicializa WhatsApp
    await initWhatsAppClient();
    console.log('[CHILD] 🟢 WhatsApp inicializado');

    // Log de memória a cada 30s
    setInterval(() => {
        const mem = process.memoryUsage();
        console.log(`[CHILD MEMORY] RSS: ${Math.round(mem.rss/1024/1024)}MB | Heap: ${Math.round(mem.heapUsed/1024/1024)}MB`);
    }, 30000);
}

main().catch(err => {
    console.error('[CHILD] Erro fatal:', err.message);
    process.exit(1);
});
