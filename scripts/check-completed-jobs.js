// scripts/check-completed-jobs.js
import Redis from 'ioredis';
import { Queue } from 'bullmq';

const redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379
});

async function checkCompleted() {
    console.log('🔍 Verificando jobs completados...\n');
    
    const queue = new Queue('payment-processing', { connection: redis });
    const completed = await queue.getCompleted();
    
    console.log(`📊 Total completados: ${completed.length}\n`);
    
    // Pega os últimos 3
    const recent = completed.slice(-3);
    
    recent.forEach((job, idx) => {
        console.log(`\n--- Job ${idx + 1} ---`);
        console.log(`ID: ${job.id}`);
        console.log(`Evento: ${job.data.eventType}`);
        console.log(`Appointment: ${job.data.payload?.appointmentId}`);
        console.log(`Amount: ${job.data.payload?.amount}`);
        console.log(`Processado em: ${job.processedOn ? new Date(job.processedOn).toLocaleString() : 'N/A'}`);
        console.log(`Return value:`, job.returnvalue);
    });
    
    await redis.quit();
    process.exit(0);
}

checkCompleted().catch(err => {
    console.error('❌ Erro:', err);
    process.exit(1);
});
