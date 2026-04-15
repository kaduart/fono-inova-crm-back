#!/usr/bin/env node
/**
 * 🔍 Lista jobs completados recentemente
 */
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import dotenv from 'dotenv';

dotenv.config();

const redisUrl = process.env.REDIS_URL;

async function checkCompletedJobs() {
    console.log('🔍 Verificando jobs completados recentemente\n');
    
    const redis = new Redis(redisUrl, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false
    });
    
    try {
        const queue = new Queue('complete-orchestrator', { connection: redis });
        
        const completed = await queue.getCompleted(0, 20);
        
        console.log(`📊 Últimos ${completed.length} jobs completados:\n`);
        
        completed.forEach((job, idx) => {
            const payload = job.data?.payload || job.data;
            console.log(`${idx + 1}. Job ${job.id}:`);
            console.log(`   Appointment: ${payload?.appointmentId || 'N/A'}`);
            console.log(`   Processado em: ${job.processedOn ? new Date(job.processedOn).toLocaleString() : 'N/A'}`);
            console.log(`   Resultado:`, JSON.stringify(job.returnvalue, null, 2));
            console.log('');
        });
        
        await queue.close();
        
    } catch (err) {
        console.error('❌ Erro:', err.message);
    } finally {
        await redis.quit();
        process.exit(0);
    }
}

checkCompletedJobs();
