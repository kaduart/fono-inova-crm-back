// scripts/check-payment-queue.js
import Redis from 'ioredis';
import { Queue } from 'bullmq';

const redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379
});

async function checkQueues() {
    console.log('🔍 Verificando filas...\n');
    
    // Verifica jobs na fila payment-processing
    const queue = new Queue('payment-processing', { connection: redis });
    
    const [waiting, active, completed, failed] = await Promise.all([
        queue.getWaiting(),
        queue.getActive(),
        queue.getCompleted(),
        queue.getFailed()
    ]);
    
    console.log('📊 Fila: payment-processing');
    console.log(`   🕐 Waiting:   ${waiting.length}`);
    console.log(`   ⚡ Active:    ${active.length}`);
    console.log(`   ✅ Completed: ${completed.length}`);
    console.log(`   ❌ Failed:    ${failed.length}`);
    
    if (waiting.length > 0) {
        console.log('\n🕐 Jobs waiting:');
        waiting.forEach(job => {
            console.log(`   - Job ${job.id}: ${job.data.eventType} (${job.data.payload?.appointmentId})`);
        });
    }
    
    if (failed.length > 0) {
        console.log('\n❌ Jobs failed (últimos 3):');
        failed.slice(0, 3).forEach(job => {
            console.log(`   - Job ${job.id}: ${job.failedReason}`);
        });
    }
    
    // Verifica também a appointment-processing
    const aptQueue = new Queue('appointment-processing', { connection: redis });
    const aptWaiting = await aptQueue.getWaiting();
    console.log(`\n📊 Fila: appointment-processing`);
    console.log(`   🕐 Waiting: ${aptWaiting.length}`);
    
    await redis.quit();
    process.exit(0);
}

checkQueues().catch(err => {
    console.error('❌ Erro:', err);
    process.exit(1);
});
