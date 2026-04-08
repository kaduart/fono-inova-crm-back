/**
 * DIAGNÓSTICO DO COMPLETE WORKER
 * Verifica se o worker está processando eventos corretamente
 */

import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import mongoose from 'mongoose';
import EventStore from '../models/EventStore.js';
import Appointment from '../models/Appointment.js';

const redisConnection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
    enableReadyCheck: false
});

async function diagnose() {
    console.log('🔍 DIAGNÓSTICO DO SISTEMA DE COMPLETE\n');
    
    try {
        // 1. Verificar fila complete-orchestrator
        console.log('1️⃣  Verificando fila "complete-orchestrator"...');
        const queue = new Queue('complete-orchestrator', { connection: redisConnection });
        
        const jobCounts = await queue.getJobCounts();
        console.log('   📊 Jobs na fila:', jobCounts);
        
        // 2. Verificar jobs pendentes
        const waitingJobs = await queue.getWaiting();
        console.log(`   ⏳ Jobs aguardando: ${waitingJobs.length}`);
        
        const activeJobs = await queue.getActive();
        console.log(`   🔄 Jobs ativos: ${activeJobs.length}`);
        
        const failedJobs = await queue.getFailed();
        console.log(`   ❌ Jobs falhos: ${failedJobs.length}`);
        
        if (failedJobs.length > 0) {
            console.log('\n   📋 Detalhes dos jobs falhos:');
            for (const job of failedJobs.slice(0, 3)) {
                console.log(`      - Job ${job.id}:`, job.failedReason);
            }
        }

        // 3. Verificar EventStore
        console.log('\n2️⃣  Verificando EventStore...');
        await mongoose.connect(process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/test');
        
        const pendingEvents = await EventStore.countDocuments({ status: 'processing' });
        console.log(`   📝 Eventos em "processing": ${pendingEvents}`);
        
        const failedEvents = await EventStore.countDocuments({ status: 'failed' });
        console.log(`   ❌ Eventos falhos: ${failedEvents}`);
        
        // 4. Buscar eventos do appointment problemático
        console.log('\n3️⃣  Verificando eventos do appointment 69cd1764856a4f39ce254cb7...');
        const appointmentEvents = await EventStore.find({
            aggregateId: '69cd1764856a4f39ce254cb7'
        }).sort({ createdAt: -1 }).limit(5);
        
        if (appointmentEvents.length === 0) {
            console.log('   ⚠️  Nenhum evento encontrado no EventStore');
            console.log('   💡 O evento pode não ter sido publicado corretamente');
        } else {
            console.log(`   📋 ${appointmentEvents.length} evento(s) encontrado(s):`);
            for (const evt of appointmentEvents) {
                console.log(`      - ${evt.eventType}: ${evt.status} (${evt.createdAt.toISOString()})`);
            }
        }
        
        // 5. Verificar appointments travados
        console.log('\n4️⃣  Verificando appointments travados em "processing_complete"...');
        const stuckAppointments = await Appointment.countDocuments({
            operationalStatus: 'processing_complete'
        });
        console.log(`   ⚠️  Total de appointments travados: ${stuckAppointments}`);
        
        if (stuckAppointments > 0) {
            const recentStuck = await Appointment.find({
                operationalStatus: 'processing_complete'
            }).sort({ updatedAt: -1 }).limit(5).select('_id patient date time updatedAt');
            
            console.log('   📋 Recentes:');
            for (const apt of recentStuck) {
                console.log(`      - ${apt._id} | Paciente: ${apt.patient} | ${apt.date?.toISOString().split('T')[0]} ${apt.time}`);
            }
        }
        
        // 6. Recomendações
        console.log('\n' + '='.repeat(60));
        console.log('📋 RECOMENDAÇÕES:');
        console.log('='.repeat(60));
        
        if (jobCounts.waiting > 0 || jobCounts.active > 0) {
            console.log('✅ A fila tem jobs pendentes. O worker pode estar processando.');
        }
        
        if (failedJobs.length > 0) {
            console.log('⚠️  Há jobs falhos na fila. Verifique os logs do worker.');
        }
        
        if (pendingEvents > 0) {
            console.log('⚠️  Há eventos presos em "processing" no EventStore.');
        }
        
        if (stuckAppointments > 0) {
            console.log(`🚨 Há ${stuckAppointments} appointment(s) travado(s) em "processing_complete"!`);
            console.log('   → Execute o script reset-appointment-luiza.js para corrigir');
        }
        
        console.log('\n📋 COMANDOS ÚTEIS:');
        console.log('   → Limpar fila: node scripts/clear-complete-queue.js');
        console.log('   → Resetar appointment: node scripts/reset-appointment-luiza.js');
        console.log('   → Ver logs: tail -f logs-archive/server.log | grep -i "complete"');

    } catch (error) {
        console.error('❌ Erro no diagnóstico:', error.message);
    } finally {
        await mongoose.disconnect();
        await redisConnection.quit();
    }
}

diagnose();
