/**
 * RESET CAUTELOSO - Luiza Bueno Lima
 * Verifica e corrige status travado em 'processing_complete'
 */

import mongoose from 'mongoose';
import Appointment from '../models/Appointment.js';

async function resetStatus() {
    try {
        const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/test';
        await mongoose.connect(MONGO_URI);
        console.log('✅ Conectado ao MongoDB\n');

        // Buscar agendamento da Luiza de hoje
        const targetDate = new Date('2026-04-07T03:00:00.000Z');
        const endOfDay = new Date('2026-04-08T02:59:59.999Z');

        const luiza = await mongoose.connection.collection('patients').findOne({
            fullName: { $regex: /luiza.*bueno.*lima/i }
        });

        if (!luiza) {
            console.log('❌ Luiza não encontrada');
            return;
        }

        console.log('👤 Paciente:', luiza.fullName, `(${luiza._id})`);

        const appointment = await Appointment.findOne({
            patient: luiza._id,
            date: { $gte: targetDate, $lte: endOfDay }
        });

        if (!appointment) {
            console.log('❌ Agendamento não encontrado');
            return;
        }

        console.log('\n📋 AGENDAMENTO ENCONTRADO:');
        console.log('   ID:', appointment._id);
        console.log('   Status operacional:', appointment.operationalStatus);
        console.log('   Status clínico:', appointment.clinicalStatus);
        console.log('   Data:', appointment.date);
        console.log('   Hora:', appointment.time);

        // Verificar se está travado
        if (appointment.operationalStatus === 'processing_complete') {
            console.log('\n⚠️  Status está em PROCESSING_COMPLETE (travado)');
            
            // Verificar histórico
            const lastHistory = appointment.history?.[appointment.history.length - 1];
            console.log('\n📜 Última ação no histórico:');
            console.log('   Ação:', lastHistory?.action || 'N/A');
            console.log('   Timestamp:', lastHistory?.timestamp || 'N/A');
            console.log('   Por:', lastHistory?.changedBy || 'N/A');

            // Perguntar antes de resetar
            console.log('\n' + '='.repeat(60));
            console.log('⚠️  OPÇÕES:');
            console.log('='.repeat(60));
            console.log('1. Resetar para SCHEDULED (permitir finalizar novamente)');
            console.log('2. Marcar como COMPLETED (se já foi atendida)');
            console.log('3. Só mostrar, não fazer nada');
            console.log('='.repeat(60));
            console.log('\n✅ Para resetar, execute manualmente no MongoDB:');
            console.log(`\n   db.appointments.updateOne(`);
            console.log(`     { _id: ObjectId('${appointment._id}') },`);
            console.log(`     { $set: { operationalStatus: 'scheduled' } }`);
            console.log(`   )`);
            
        } else {
            console.log('\n✅ Status está OK:', appointment.operationalStatus);
        }

    } catch (error) {
        console.error('❌ Erro:', error);
    } finally {
        await mongoose.disconnect();
        console.log('\n👋 Desconectado');
    }
}

resetStatus();
