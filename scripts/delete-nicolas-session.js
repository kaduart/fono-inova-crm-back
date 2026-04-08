/**
 * Script para excluir sessão avulsa do Nicolas Lucca
 * Data: 06/04/2026 às 16:00
 */

import mongoose from 'mongoose';
import moment from 'moment-timezone';
import Patient from '../models/Patient.js';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';

const TIMEZONE = 'America/Sao_Paulo';

async function deleteNicolasSession() {
    try {
        // Conectar ao MongoDB
        const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/test';
        await mongoose.connect(MONGO_URI);
        console.log('✅ Conectado ao MongoDB');

        // 1. Buscar paciente Nicolas Lucca
        const patient = await Patient.findOne({ 
            fullName: { $regex: /nicolas.*lucca/i } 
        });
        
        if (!patient) {
            console.log('❌ Paciente Nicolas Lucca não encontrado');
            return;
        }
        
        console.log(`✅ Paciente encontrado: ${patient.fullName} (${patient._id})`);

        // 2. Definir período do dia 06/04/2026
        const targetDate = moment.tz('2026-04-06', 'YYYY-MM-DD', TIMEZONE);
        const startOfDay = targetDate.clone().startOf('day').toDate();
        const endOfDay = targetDate.clone().endOf('day').toDate();
        
        console.log(`📅 Buscando dados de ${targetDate.format('DD/MM/YYYY')}`);

        // 3. Buscar agendamentos do dia às 16h
        const appointments = await Appointment.find({
            patient: patient._id,
            date: { $gte: startOfDay, $lte: endOfDay },
            time: '16:00'
        });
        
        console.log(`📋 Agendamentos encontrados: ${appointments.length}`);
        appointments.forEach(a => {
            console.log(`   - ID: ${a._id}, Data: ${a.date}, Hora: ${a.time}, Package: ${a.package || 'AVULSO'}`);
        });

        // 4. Buscar sessões avulsas (sem package) do dia às 16h
        const sessions = await Session.find({
            patient: patient._id,
            date: { $gte: startOfDay, $lte: endOfDay },
            time: '16:00',
            $or: [
                { package: { $exists: false } },
                { package: null }
            ]
        });
        
        console.log(`🗓️ Sessões AVULSAS encontradas: ${sessions.length}`);
        sessions.forEach(s => {
            console.log(`   - ID: ${s._id}, Data: ${s.date}, Hora: ${s.time}, Package: ${s.package || 'AVULSO'}`);
        });

        // 5. Buscar pagamentos avulsos do dia
        const payments = await Payment.find({
            patient: patient._id,
            paymentDate: { $gte: startOfDay, $lte: endOfDay },
            $or: [
                { package: { $exists: false } },
                { package: null }
            ]
        });
        
        console.log(`💰 Pagamentos AVULSOS encontrados: ${payments.length}`);
        payments.forEach(p => {
            console.log(`   - ID: ${p._id}, Valor: R$ ${p.amount}, Package: ${p.package || 'AVULSO'}`);
        });

        // 6. CONFIRMAR EXCLUSÃO
        console.log('\n' + '='.repeat(60));
        console.log('⚠️  ITENS QUE SERÃO EXCLUÍDOS:');
        console.log('='.repeat(60));
        
        const toDelete = {
            appointments: appointments.filter(a => !a.package), // Só avulsos
            sessions: sessions, // Já filtrado por avulsos
            payments: payments  // Já filtrado por avulsos
        };
        
        console.log(`📋 Agendamentos avulsos: ${toDelete.appointments.length}`);
        console.log(`🗓️ Sessões avulsas: ${toDelete.sessions.length}`);
        console.log(`💰 Pagamentos avulsos: ${toDelete.payments.length}`);
        
        // 7. EXCLUIR (descomente as linhas abaixo para realmente excluir)
        console.log('\n🗑️ Excluindo...');
        
        for (const apt of toDelete.appointments) {
            await Appointment.deleteOne({ _id: apt._id });
            console.log(`   ✅ Agendamento excluído: ${apt._id}`);
        }
        
        for (const session of toDelete.sessions) {
            await Session.deleteOne({ _id: session._id });
            console.log(`   ✅ Sessão excluída: ${session._id}`);
        }
        
        for (const payment of toDelete.payments) {
            await Payment.deleteOne({ _id: payment._id });
            console.log(`   ✅ Pagamento excluído: ${payment._id}`);
        }
        
        console.log('\n✅ EXCLUSÃO CONCLUÍDA!');
        console.log('Itens de PACOTE não foram excluídos (conforme solicitado).');

    } catch (error) {
        console.error('❌ Erro:', error);
    } finally {
        await mongoose.disconnect();
        console.log('👋 Desconectado do MongoDB');
    }
}

// Executar
deleteNicolasSession();
