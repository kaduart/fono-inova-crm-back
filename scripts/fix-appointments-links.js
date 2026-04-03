import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Appointment from '../models/Appointment.js';
import Patient from '../models/Patient.js';
import Doctor from '../models/Doctor.js';
import Leads from '../models/Leads.js';

dotenv.config();

async function fixAppointments() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Conectado ao MongoDB');
        console.log(`📊 Banco: ${mongoose.connection.db.databaseName}`);

        // Buscar todos os agendamentos sem paciente ou médico
        const appointments = await Appointment.find({
            $or: [
                { patient: null },
                { doctor: null }
            ]
        }).populate('lead', 'patientInfo name');

        console.log(`\n🔍 Encontrados ${appointments.length} agendamentos para corrigir`);

        // Cache de pacientes e médicos
        const patientCache = {};
        const doctorCache = {};

        // Buscar todos os pacientes e médicos para cache
        const allPatients = await Patient.find({});
        const allDoctors = await Doctor.find({});

        // Indexar por nome
        allPatients.forEach(p => {
            const name = p.fullName?.toLowerCase().trim();
            if (name) patientCache[name] = p._id;
        });

        allDoctors.forEach(d => {
            const name = d.fullName?.toLowerCase().trim();
            if (name) doctorCache[name] = d._id;
            // Também indexar por especialidade
            if (d.specialty) {
                if (!doctorCache[d.specialty]) doctorCache[d.specialty] = [];
                doctorCache[d.specialty].push(d._id);
            }
        });

        console.log(`📋 ${allPatients.length} pacientes em cache`);
        console.log(`📋 ${allDoctors.length} médicos em cache`);

        let fixedCount = 0;

        for (const appt of appointments) {
            console.log(`\n📝 Processando agendamento: ${appt._id}`);
            console.log(`   Data: ${appt.date} ${appt.time}`);
            console.log(`   Especialidade: ${appt.specialty}`);
            
            const updates = {};

            // Tentar vincular paciente
            if (!appt.patient && appt.lead) {
                const lead = appt.lead;
                const patientName = lead?.patientInfo?.fullName?.toLowerCase().trim() || 
                                   lead?.name?.toLowerCase().trim();
                
                console.log(`   Nome do paciente no lead: ${patientName}`);

                if (patientName && patientCache[patientName]) {
                    updates.patient = patientCache[patientName];
                    console.log(`   ✅ Paciente vinculado: ${patientCache[patientName]}`);
                } else {
                    console.log(`   ⚠️ Paciente não encontrado no cache`);
                }
            }

            // Tentar vincular médico pela especialidade
            if (!appt.doctor && appt.specialty) {
                const specialtyDoctors = doctorCache[appt.specialty];
                
                if (specialtyDoctors && specialtyDoctors.length > 0) {
                    // Pegar o primeiro médico dessa especialidade
                    updates.doctor = specialtyDoctors[0];
                    console.log(`   ✅ Médico vinculado pela especialidade ${appt.specialty}`);
                } else {
                    console.log(`   ⚠️ Nenhum médico encontrado para especialidade: ${appt.specialty}`);
                }
            }

            // Aplicar atualizações
            if (Object.keys(updates).length > 0) {
                await Appointment.updateOne(
                    { _id: appt._id },
                    { $set: updates }
                );
                console.log(`   💾 Atualizações salvas`);
                fixedCount++;
            } else {
                console.log(`   ⏭️ Nenhuma atualização necessária`);
            }
        }

        console.log(`\n✅ Concluído! ${fixedCount} agendamentos corrigidos.`);

    } catch (error) {
        console.error('❌ Erro:', error);
    } finally {
        await mongoose.disconnect();
        console.log('🔌 Desconectado do MongoDB');
    }
}

fixAppointments();
