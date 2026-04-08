/**
 * LIMPA FILA E REPROCESSA APPOINTMENT DA LUIZA
 */

import { Queue } from 'bullmq';
import Redis from 'ioredis';
import mongoose from 'mongoose';
import Appointment from '../models/Appointment.js';

const redisConnection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
    enableReadyCheck: false
});

async function clearAndRetry() {
    console.log('🧹 LIMPANDO FILA E RESETANDO...\n');
    
    try {
        // 1. Limpar fila complete-orchestrator
        const queue = new Queue('complete-orchestrator', { connection: redisConnection });
        await queue.obliterate({ force: true });
        console.log('✅ Fila complete-orchestrator limpa');
        
        // 2. Conectar MongoDB
        await mongoose.connect(process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/test');
        
        // 3. Resetar appointment da Luiza
        const APPOINTMENT_ID = '69cd1764856a4f39ce254cb7';
        const apt = await Appointment.findById(APPOINTMENT_ID);
        
        if (apt) {
            console.log('\n📋 Appointment antes:', apt.operationalStatus);
            apt.operationalStatus = 'scheduled';
            apt.history.push({
                action: 'manual_reset_for_retry',
                newStatus: 'scheduled',
                timestamp: new Date()
            });
            await apt.save();
            console.log('✅ Appointment resetado para scheduled');
        }
        
        // 4. Limpar eventos pendentes desse appointment
        const EventStore = (await import('../models/EventStore.js')).default;
        await EventStore.updateMany(
            { aggregateId: APPOINTMENT_ID, status: { $in: ['processing', 'pending'] } },
            { $set: { status: 'failed', error: 'Manual reset for retry' } }
        );
        console.log('✅ Eventos pendentes marcados como failed');
        
        console.log('\n' + '='.repeat(50));
        console.log('🚀 PRONTO! Agora você pode tentar completar de novo.');
        console.log('='.repeat(50));
        
    } catch (error) {
        console.error('❌ Erro:', error.message);
    } finally {
        await mongoose.disconnect();
        await redisConnection.quit();
    }
}

clearAndRetry();
