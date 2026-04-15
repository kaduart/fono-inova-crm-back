#!/usr/bin/env node
/**
 * 🔍 Verifica se o worker do complete-orchestrator está rodando
 */
import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const redisUrl = process.env.REDIS_URL;

async function checkWorkerRunning() {
    console.log('🔍 Verificando se o worker está rodando...\n');
    
    const redis = new Redis(redisUrl, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false
    });
    
    try {
        // Verifica workers registrados no BullMQ
        const workers = await redis.hgetall('bull:complete-orchestrator:workers');
        
        if (Object.keys(workers).length === 0) {
            console.log('❌ NENHUM WORKER RODANDO!\n');
            console.log('👉 Solução: Reinicie o servidor ou rode o worker separadamente:');
            console.log('   npm run dev');
            console.log('   # ou');
            console.log('   node workers/startWorkers.js');
            process.exit(1);
        }
        
        console.log('✅ WORKER ESTÁ RODANDO!\n');
        console.log('Workers registrados:');
        Object.entries(workers).forEach(([id, data]) => {
            console.log(`   - ${id}: ${data}`);
        });
        
        // Verifica jobs pendentes
        const waiting = await redis.llen('bull:complete-orchestrator:wait');
        const delayed = await redis.zcard('bull:complete-orchestrator:delayed');
        
        console.log(`\n📊 Jobs na fila:`);
        console.log(`   Waiting: ${waiting}`);
        console.log(`   Delayed: ${delayed}`);
        
        if (waiting > 0 || delayed > 0) {
            console.log('\n⏳ Jobs aguardando processamento...');
        }
        
    } catch (err) {
        console.error('❌ Erro:', err.message);
    } finally {
        await redis.quit();
        process.exit(0);
    }
}

checkWorkerRunning();
