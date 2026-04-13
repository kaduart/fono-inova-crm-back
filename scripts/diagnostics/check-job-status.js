#!/usr/bin/env node
/**
 * 🔍 Verifica status de um job específico na fila
 * Uso: node check-job-status.js <appointmentId>
 */
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Appointment from './models/Appointment.js';

dotenv.config();

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const appointmentId = process.argv[2];

if (!appointmentId) {
    console.error('❌ Uso: node check-job-status.js <appointmentId>');
    process.exit(1);
}

async function checkJobStatus() {
    console.log(`🔍 Verificando status do appointment: ${appointmentId}\n`);
    
    const redis = new Redis(redisUrl, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false
    });
    
    try {
        // Conecta MongoDB
        const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
        if (!MONGO_URI) {
            console.error('❌ MONGODB_URI não configurado');
            process.exit(1);
        }
        await mongoose.connect(MONGO_URI);
        
        // Busca appointment
        const appointment = await Appointment.findById(appointmentId);
        console.log('📋 Appointment no MongoDB:');
        console.log(`   Status: ${appointment?.operationalStatus || 'NÃO ENCONTRADO'}`);
        console.log(`   Clinical: ${appointment?.clinicalStatus || 'N/A'}`);
        console.log(`   Session: ${appointment?.session || 'N/A'}`);
        console.log(`   Package: ${appointment?.package || 'N/A'}`);
        console.log('');
        
        // Verifica fila
        const queue = new Queue('complete-orchestrator', { connection: redis });
        
        const [waiting, active, completed, failed] = await Promise.all([
            queue.getWaiting(),
            queue.getActive(),
            queue.getCompleted(0, 10),
            queue.getFailed(0, 10)
        ]);
        
        console.log('📊 Jobs na fila:');
        
        // Procura job relacionado ao appointment
        const findJob = (jobs) => jobs.find(j => 
            j.data?.payload?.appointmentId === appointmentId ||
            j.data?.appointmentId === appointmentId
        );
        
        const waitingJob = findJob(waiting);
        const activeJob = findJob(active);
        const completedJob = findJob(completed);
        const failedJob = findJob(failed);
        
        if (waitingJob) {
            console.log(`   ⏳ WAITING: Job ${waitingJob.id} aguardando`);
            console.log(`      Data:`, JSON.stringify(waitingJob.data, null, 2));
        } else if (activeJob) {
            console.log(`   🔄 ACTIVE: Job ${activeJob.id} em processamento`);
        } else if (completedJob) {
            console.log(`   ✅ COMPLETED: Job ${completedJob.id} processado`);
            console.log(`      Return:`, completedJob.returnvalue);
        } else if (failedJob) {
            console.log(`   ❌ FAILED: Job ${failedJob.id} falhou`);
            console.log(`      Erro: ${failedJob.failedReason}`);
            console.log(`      Stack:`, failedJob.stacktrace?.[0]);
        } else {
            console.log(`   ⚠️  Nenhum job encontrado para este appointment`);
            console.log(`      Total waiting: ${waiting.length}`);
            console.log(`      Total active: ${active.length}`);
            console.log(`      Total completed: ${completed.length}`);
            console.log(`      Total failed: ${failed.length}`);
        }
        
        await queue.close();
        
    } catch (err) {
        console.error('❌ Erro:', err.message);
        console.error(err.stack);
    } finally {
        await redis.quit();
        await mongoose.disconnect();
        process.exit(0);
    }
}

checkJobStatus();
