#!/usr/bin/env node
/**
 * 🚨 Força o complete de um appointment manualmente
 * Uso: node force-complete.js <appointmentId>
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Appointment from './models/Appointment.js';
import Session from './models/Session.js';
import Payment from './models/Payment.js';
import { normalizeSessionType } from './utils/sessionTypeResolver.js';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
const appointmentId = process.argv[2];

if (!appointmentId) {
    console.error('❌ Uso: node force-complete.js <appointmentId>');
    process.exit(1);
}

async function forceComplete() {
    console.log(`🚨 Forçando complete do appointment: ${appointmentId}\n`);
    
    try {
        await mongoose.connect(MONGO_URI);
        console.log('✅ MongoDB conectado\n');
        
        const appointment = await Appointment.findById(appointmentId);
        
        if (!appointment) {
            console.error('❌ Appointment não encontrado');
            process.exit(1);
        }
        
        console.log('📋 Estado atual do appointment:');
        console.log(`   operationalStatus: ${appointment.operationalStatus}`);
        console.log(`   clinicalStatus: ${appointment.clinicalStatus}`);
        console.log(`   paymentStatus: ${appointment.paymentStatus}`);
        console.log(`   session: ${appointment.session}`);
        console.log(`   package: ${appointment.package}`);
        console.log('');
        
        // Libera o lock se estiver em processing
        if (appointment.operationalStatus === 'processing_complete') {
            console.log('🔓 Liberando lock de processing_complete...');
            appointment.operationalStatus = 'scheduled';
            appointment.history.push({
                action: 'manual_lock_release',
                previousStatus: 'processing_complete',
                newStatus: 'scheduled',
                timestamp: new Date(),
                context: 'Script de correção manual'
            });
            await appointment.save();
            console.log('✅ Lock liberado\n');
        }
        
        // Verifica se tem sessão
        if (!appointment.session) {
            console.log('⚠️  Appointment não tem sessão vinculada!');
            console.log('   Criando sessão...');
            
            const session = new Session({
                patient: appointment.patient,
                doctor: appointment.doctor,
                appointment: appointment._id,
                date: appointment.date,
                time: appointment.time,
                specialty: appointment.specialty,
                sessionType: normalizeSessionType(appointment.specialty),
                status: 'scheduled',
                paymentStatus: 'pending',
                isPaid: false
            });
            
            await session.save();
            appointment.session = session._id;
            await appointment.save();
            console.log(`✅ Sessão criada: ${session._id}\n`);
        }
        
        // Completa a sessão
        const session = await Session.findById(appointment.session);
        if (session && session.status !== 'completed') {
            console.log('✅ Completando sessão...');
            session.status = 'completed';
            session.isPaid = false;
            session.paymentStatus = 'pending';
            session.visualFlag = 'pending';
            await session.save();
            console.log('✅ Sessão completada\n');
        }
        
        // Atualiza appointment
        console.log('✅ Atualizando appointment...');
        appointment.operationalStatus = 'confirmed';
        appointment.clinicalStatus = 'completed';
        appointment.paymentStatus = 'pending';
        appointment.visualFlag = 'pending';
        appointment.completedAt = new Date();
        appointment.history.push({
            action: 'complete_manual_script',
            newStatus: 'confirmed',
            timestamp: new Date(),
            context: 'Script de correção manual - force complete'
        });
        await appointment.save();
        
        console.log('\n🎉 Appointment completado com sucesso!');
        console.log(`   ID: ${appointment._id}`);
        console.log(`   Status: ${appointment.operationalStatus}`);
        console.log(`   Clinical: ${appointment.clinicalStatus}`);
        
    } catch (err) {
        console.error('❌ Erro:', err.message);
        console.error(err.stack);
    } finally {
        await mongoose.disconnect();
        process.exit(0);
    }
}

forceComplete();
