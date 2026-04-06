// scripts/check-dlq.js
import Redis from 'ioredis';
import { Queue } from 'bullmq';

const redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379
});

async function checkDLQ() {
    console.log('🔍 Verificando Dead Letter Queue...\n');
    
    const dlq = new Queue('dlq', { connection: redis });
    
    const [waiting, completed] = await Promise.all([
        dlq.getWaiting(),
        dlq.getCompleted()
    ]);
    
    console.log(`📊 DLQ - Waiting: ${waiting.length}`);
    console.log(`📊 DLQ - Completed: ${completed.length}`);
    
    if (waiting.length > 0) {
        console.log('\n❌ Jobs na DLQ:');
        waiting.forEach(job => {
            console.log(`\n--- Job ${job.id} ---`);
            console.log(`Evento: ${job.data.originalJob?.eventType}`);
            console.log(`Erro: ${job.data.error?.message}`);
            console.log(`Stack: ${job.data.error?.stack?.substring(0, 200)}...`);
        });
    }
    
    // Verificar também se existe fila delayed
    const paymentQueue = new Queue('payment-processing', { connection: redis });
    const delayed = await paymentQueue.getDelayed();
    console.log(`\n📊 Payment Queue - Delayed: ${delayed.length}`);
    
    await redis.quit();
    process.exit(0);
}

checkDLQ().catch(err => {
    console.error('❌ Erro:', err);
    process.exit(1);
});
