/**
 * DIAGNÓSTICO COMPLETO DO SISTEMA DE WORKERS
 * Verifica filas, workers e eventos travados
 */

import { Queue } from 'bullmq';
import Redis from 'ioredis';
import mongoose from 'mongoose';
import EventStore from '../models/EventStore.js';
import Appointment from '../models/Appointment.js';

const redisConnection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
    enableReadyCheck: false
});

async function diagnose() {
    console.log('🔍 DIAGNÓSTICO DO SISTEMA DE WORKERS\n');
    console.log('=' .repeat(60));
    
    try {
        // 1. Verificar fila complete-orchestrator
        console.log('\n1️⃣  FILA "complete-orchestrator"');
        console.log('-'.repeat(40));
        const completeQueue = new Queue('complete-orchestrator', { connection: redisConnection });
        
        const jobCounts = await completeQueue.getJobCounts();
        console.log('   📊 Jobs:', JSON.stringify(jobCounts, null, 2));
        
        const waitingJobs = await completeQueue.getWaiting();
        console.log(`   ⏳ Waiting: ${waitingJobs.length}`);
        
        const activeJobs = await completeQueue.getActive();
        console.log(`   🔄 Active: ${activeJobs.length}`);
        
        const failedJobs = await completeQueue.getFailed();
        console.log(`   ❌ Failed: ${failedJobs.length}`);
        
        const delayedJobs = await completeQueue.getDelayed();
        console.log(`   ⏰ Delayed: ${delayedJobs.length}`);
        
        if (failedJobs.length > 0) {
            console.log('\n   📋 Últimos jobs falhos:');
            for (const job of failedJobs.slice(0, 3)) {
                console.log(`      - Job ${job.id}: ${job.failedReason}`);
                console.log(`        Data:`, JSON.stringify(job.data, null, 2));
            }
        }
        
        if (waitingJobs.length > 0) {
            console.log('\n   📋 Jobs aguardando:');
            for (const job of waitingJobs.slice(0, 3)) {
                console.log(`      - Job ${job.id}: ${job.data?.eventType}`);
            }
        }

        // 2. Conectar MongoDB
        console.log('\n2️⃣  MONGODB - EventStore');
        console.log('-'.repeat(40));
        await mongoose.connect(process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/test');
        
        const stats = {
            total: await EventStore.countDocuments(),
            pending: await EventStore.countDocuments({ status: 'pending' }),
            processing: await EventStore.countDocuments({ status: 'processing' }),
            processed: await EventStore.countDocuments({ status: 'processed' }),
            failed: await EventStore.countDocuments({ status: 'failed' })
        };
        console.log('   📊 EventStore:', JSON.stringify(stats, null, 2));
        
        // 3. Eventos do appointment problemático
        console.log('\n3️⃣  EVENTOS DO APPOINTMENT 69cd1764856a4f39ce254cb7');
        console.log('-'.repeat(40));
        const appointmentEvents = await EventStore.find({
            aggregateId: '69cd1764856a4f39ce254cb7'
        }).sort({ createdAt: -1 }).limit(10);
        
        if (appointmentEvents.length === 0) {
            console.log('   ⚠️  Nenhum evento encontrado no EventStore');
        } else {
            console.log(`   📋 ${appointmentEvents.length} evento(s):`);
            for (const evt of appointmentEvents) {
                const age = Math.floor((Date.now() - evt.updatedAt.getTime()) / 1000 / 60);
                console.log(`      - ${evt.eventType}: ${evt.status} (${age} min atrás)`);
            }
        }
        
        // 4. Verificar appointments travados em processing_complete
        console.log('\n4️⃣  APPOINTMENTS TRAVADOS EM "processing_complete"');
        console.log('-'.repeat(40));
        const stuckAppointments = await Appointment.find({
            operationalStatus: 'processing_complete'
        }).sort({ updatedAt: -1 }).limit(10).select('_id patient date time updatedAt operationalStatus');
        
        console.log(`   ⚠️  Total: ${await Appointment.countDocuments({ operationalStatus: 'processing_complete' })}`);
        
        if (stuckAppointments.length > 0) {
            console.log('   📋 Recentes:');
            for (const apt of stuckAppointments) {
                const age = Math.floor((Date.now() - apt.updatedAt.getTime()) / 1000 / 60);
                console.log(`      - ${apt._id} | ${apt.date?.toISOString().split('T')[0]} ${apt.time} | ${age} min`);
            }
        }
        
        // 5. Verificar eventos stale (processing há mais de 5 min)
        console.log('\n5️⃣  EVENTOS STALE (processing > 5 min)');
        console.log('-'.repeat(40));
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
        const staleEvents = await EventStore.find({
            status: 'processing',
            updatedAt: { $lt: fiveMinutesAgo }
        }).sort({ updatedAt: -1 }).limit(10);
        
        console.log(`   ⚠️  Total: ${await EventStore.countDocuments({ status: 'processing', updatedAt: { $lt: fiveMinutesAgo } })}`);
        
        if (staleEvents.length > 0) {
            console.log('   📋 Eventos stale:');
            for (const evt of staleEvents) {
                const age = Math.floor((Date.now() - evt.updatedAt.getTime()) / 1000 / 60);
                console.log(`      - ${evt.eventType} | ${evt.aggregateId} | ${age} min parado`);
            }
        }
        
        // 6. Recomendações
        console.log('\n' + '='.repeat(60));
        console.log('📋 RECOMENDAÇÕES:');
        console.log('='.repeat(60));
        
        if (jobCounts.waiting > 0) {
            console.log('✅ Há jobs na fila waiting. O worker deve processar.');
        }
        
        if (jobCounts.active > 0) {
            console.log('🔄 Há jobs ativos. Worker pode estar processando agora.');
        }
        
        if (failedJobs.length > 0) {
            console.log('❌ Há jobs falhos! Verifique os logs do worker.');
        }
        
        if (stats.processing > 0) {
            console.log(`⚠️  ${stats.processing} evento(s) em "processing" no EventStore.`);
        }
        
        if (staleEvents.length > 0) {
            console.log(`🚨 ${staleEvents.length} evento(s) STALE (travados há +5min)!`);
            console.log('   → O worker deveria reprocessar esses eventos automaticamente.');
        }
        
        if (stuckAppointments.length > 0) {
            console.log(`🚨 ${await Appointment.countDocuments({ operationalStatus: 'processing_complete' })} appointment(s) travado(s)!`);
            console.log('   → Execute: node scripts/reset-all-processing.js');
        }
        
        console.log('\n📋 PRÓXIMOS PASSOS:');
        console.log('   1. Verificar se o worker está rodando: pm2 list');
        console.log('   2. Ver logs: pm2 logs');
        console.log('   3. Se necessário, reiniciar worker: pm2 restart <id>');
        
    } catch (error) {
        console.error('❌ Erro no diagnóstico:', error.message);
        console.error(error.stack);
    } finally {
        await mongoose.disconnect();
        await redisConnection.quit();
    }
}

diagnose();
