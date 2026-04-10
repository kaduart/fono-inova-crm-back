#!/usr/bin/env node
/**
 * 🔍 Debug rápido da fila complete-orchestrator
 */
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import dotenv from 'dotenv';

dotenv.config();

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

async function debugQueue() {
    console.log('🔍 Verificando fila complete-orchestrator...\n');
    
    const redis = new Redis(redisUrl, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false
    });
    
    try {
        // Testa conexão Redis
        await redis.ping();
        console.log('✅ Redis conectado\n');
        
        const queue = new Queue('complete-orchestrator', { connection: redis });
        
        // Conta jobs em cada estado
        const [waiting, active, completed, failed, delayed] = await Promise.all([
            queue.getWaitingCount(),
            queue.getActiveCount(),
            queue.getCompletedCount(),
            queue.getFailedCount(),
            queue.getDelayedCount()
        ]);
        
        console.log('📊 Status da fila:');
        console.log(`   Waiting:  ${waiting}`);
        console.log(`   Active:   ${active}`);
        console.log(`   Completed:${completed}`);
        console.log(`   Failed:   ${failed}`);
        console.log(`   Delayed:  ${delayed}`);
        console.log('');
        
        // Se houver jobs waiting ou failed, mostra detalhes
        if (waiting > 0) {
            const jobs = await queue.getWaiting();
            console.log('📋 Jobs waiting:');
            jobs.forEach(job => {
                console.log(`   - Job ${job.id}: ${job.name}`);
                console.log(`     Data:`, JSON.stringify(job.data, null, 2));
            });
        }
        
        if (failed > 0) {
            const jobs = await queue.getFailed();
            console.log('❌ Jobs failed:');
            jobs.forEach(job => {
                console.log(`   - Job ${job.id}: ${job.name}`);
                console.log(`     Erro: ${job.failedReason}`);
                console.log(`     Data:`, JSON.stringify(job.data, null, 2));
            });
        }
        
        await queue.close();
        
    } catch (err) {
        console.error('❌ Erro:', err.message);
    } finally {
        await redis.quit();
        process.exit(0);
    }
}

debugQueue();
