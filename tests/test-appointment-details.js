// Script para verificar agendamentos vinculados
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI;

async function checkAppointmentDetails() {
    try {
        console.log('🔌 Conectando ao MongoDB...');
        await mongoose.connect(MONGO_URI);
        console.log('✅ Conectado ao MongoDB\n');

        const { default: Appointment } = await import('../models/Appointment.js');

        const patientId = '698f0ad139d78a9c5746e037';

        console.log(`🔍 Verificando agendamentos do paciente ${patientId}:\n`);

        const appointments = await Appointment.find({ patient: patientId }).lean();

        console.log(`📋 Total de agendamentos: ${appointments.length}\n`);

        for (let i = 0; i < appointments.length; i++) {
            const a = appointments[i];
            console.log(`📅 Agendamento ${i + 1}:`);
            console.log(`   ID: ${a._id}`);
            console.log(`   Data: ${a.date}`);
            console.log(`   Hora: ${a.time}`);
            console.log(`   Status operacional: ${a.operationalStatus}`);
            console.log(`   Status clínico: ${a.clinicalStatus}`);
            console.log(`   Status de pagamento: ${a.paymentStatus}`);
            console.log(`   Tipo de serviço: ${a.serviceType}`);
            console.log(`   Especialidade: ${a.specialty}`);
            console.log(`   Doutor: ${a.doctor}`);
            console.log(`   Pacote: ${a.package || 'N/A'}`);
            console.log(`   Pagamento: ${a.payment || 'N/A'}`);
            console.log(`   Criado em: ${a.createdAt}`);
            console.log('');
        }

        // Verificar se há algum dado de lead ou outra coleção com esse ID
        console.log('\n🔍 Verificando se há leads com esse ID...');
        try {
            const { default: Lead } = await import('./models/Lead.js');
            const leads = await Lead.find({ patient: patientId }).select('_id name phone').limit(5).lean();
            if (leads.length > 0) {
                console.log(`   Encontrados ${leads.length} leads:`);
                for (const l of leads) {
                    console.log(`      - ${l._id}: ${l.name} (${l.phone})`);
                }
            } else {
                console.log('   Nenhum lead encontrado');
            }
        } catch (e) {
            console.log('   Modelo Lead não encontrado ou erro:', e.message);
        }

    } catch (error) {
        console.error('❌ Erro:', error);
    } finally {
        await mongoose.disconnect();
        console.log('\n🔌 Desconectado do MongoDB');
    }
}

checkAppointmentDetails();
