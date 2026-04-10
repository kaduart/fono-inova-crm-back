#!/usr/bin/env node
/**
 * 🚀 Inicia servidor + verifica workers
 * Uso: node start-with-workers.js
 */
import { spawn } from 'child_process';
import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

console.log('🚀 Iniciando servidor com verificação de workers...\n');

// Inicia o servidor
const server = spawn('node', ['server.js'], {
    stdio: 'inherit',
    shell: true
});

// Aguarda 5 segundos e verifica se o worker está rodando
setTimeout(async () => {
    const redis = new Redis(redisUrl, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false
    });
    
    try {
        const workers = await redis.hgetall('bull:complete-orchestrator:workers');
        
        if (Object.keys(workers).length === 0) {
            console.log('\n⚠️  ==========================================');
            console.log('⚠️  ALERTA: Worker de complete NÃO está rodando!');
            console.log('⚠️  ==========================================');
            console.log('\n👉 O complete de agendamentos NÃO vai funcionar!');
            console.log('\n🔧 Soluções:');
            console.log('   1. Reinicie o servidor: npm run dev');
            console.log('   2. Ou rode o worker separado: node workers/startWorkers.js');
            console.log('\n');
        } else {
            console.log('\n✅ ==========================================');
            console.log('✅ Worker de complete está rodando!');
            console.log('✅ ==========================================\n');
        }
    } catch (err) {
        console.error('\n❌ Erro ao verificar worker:', err.message);
    } finally {
        await redis.quit();
    }
}, 5000);

server.on('close', (code) => {
    process.exit(code);
});
