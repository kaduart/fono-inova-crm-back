/**
 * RESET DO APPOINTMENT DA LUIZA
 * Appointment ID: 69cd1764856a4f39ce254cb7
 * 
 * Este script CORRIGE o status travado em 'processing_complete'
 * 
 * ⚠️  EXECUTAR APENAS SE:
 *   1. O worker não está processando o evento
 *   2. Você quer permitir nova tentativa de finalização
 */

import mongoose from 'mongoose';
import Appointment from '../models/Appointment.js';

const APPOINTMENT_ID = '69cd1764856a4f39ce254cb7';

async function resetAppointment() {
    try {
        const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/test';
        await mongoose.connect(MONGO_URI);
        console.log('✅ Conectado ao MongoDB\n');

        const appointment = await Appointment.findById(APPOINTMENT_ID);
        
        if (!appointment) {
            console.log('❌ Appointment não encontrado');
            return;
        }

        console.log('📋 AGENDAMENTO ATUAL:');
        console.log('   ID:', appointment._id);
        console.log('   Status Operacional:', appointment.operationalStatus);
        console.log('   Status Clínico:', appointment.clinicalStatus);
        console.log('   Paciente:', appointment.patient);
        console.log('   Data:', appointment.date);
        console.log('   Hora:', appointment.time);

        // Verificar se está travado
        if (appointment.operationalStatus !== 'processing_complete') {
            console.log('\n✅ Status já está OK:', appointment.operationalStatus);
            return;
        }

        console.log('\n⚠️  Status está em PROCESSING_COMPLETE (travado)');
        
        // Verificar histórico
        const lastHistory = appointment.history?.[appointment.history.length - 1];
        console.log('\n📜 Última ação no histórico:');
        console.log('   Ação:', lastHistory?.action || 'N/A');
        console.log('   Timestamp:', lastHistory?.timestamp || 'N/A');

        // RESET para scheduled
        appointment.operationalStatus = 'scheduled';
        appointment.history.push({
            action: 'status_reset_manual',
            previousStatus: 'processing_complete',
            newStatus: 'scheduled',
            reason: 'travado_em_processing - reset manual via script',
            timestamp: new Date()
        });

        await appointment.save();
        
        console.log('\n' + '='.repeat(60));
        console.log('✅ STATUS RESETADO COM SUCESSO!');
        console.log('='.repeat(60));
        console.log('\n📋 NOVO STATUS:');
        console.log('   Status Operacional:', appointment.operationalStatus);
        console.log('   Status Clínico:', appointment.clinicalStatus);
        console.log('\n📝 Agora você pode tentar finalizar a sessão novamente!');

    } catch (error) {
        console.error('❌ Erro:', error.message);
        console.error(error.stack);
    } finally {
        await mongoose.disconnect();
        console.log('\n👋 Desconectado');
    }
}

// Executar
resetAppointment();
