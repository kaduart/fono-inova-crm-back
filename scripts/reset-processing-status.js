// ⚠️  RESET DE STATUS - EXECUTAR COM CAUTELA
// Uso: node scripts/reset-processing-status.js <appointmentId>

import mongoose from 'mongoose';
import Appointment from '../models/Appointment.js';

const appointmentId = process.argv[2];

if (!appointmentId) {
    console.log('❌ Uso: node reset-processing-status.js <appointmentId>');
    process.exit(1);
}

async function reset() {
    try {
        const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/test';
        await mongoose.connect(MONGO_URI);
        console.log('✅ Conectado\n');

        const apt = await Appointment.findById(appointmentId);
        if (!apt) {
            console.log('❌ Agendamento não encontrado');
            return;
        }

        console.log('📋 Agendamento:', apt._id);
        console.log('   Status atual:', apt.operationalStatus);
        console.log('   Paciente:', apt.patient);
        console.log('   Data:', apt.date, apt.time);

        if (apt.operationalStatus !== 'processing_complete') {
            console.log('\n✅ Não está travado. Status:', apt.operationalStatus);
            return;
        }

        // Reset para scheduled
        apt.operationalStatus = 'scheduled';
        apt.history.push({
            action: 'status_reset',
            previousStatus: 'processing_complete',
            newStatus: 'scheduled',
            reason: 'travado_em_processing',
            timestamp: new Date()
        });
        
        await apt.save();
        console.log('\n✅ Status resetado para SCHEDULED');
        console.log('   Agora pode finalizar novamente!');

    } catch (error) {
        console.error('❌ Erro:', error.message);
    } finally {
        await mongoose.disconnect();
    }
}

reset();
