const mongoose = require('mongoose');
const moment = require('moment-timezone');

// Conectar ao MongoDB local (o backend já está rodando, então deve ter acesso)
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/crm';

async function auditAppointments() {
    try {
        // Conectar via localhost se o MongoDB estiver local
        await mongoose.connect('mongodb://127.0.0.1:27017/test');
        console.log('✅ Conectado ao MongoDB');

        const Appointment = mongoose.model('Appointment', new mongoose.Schema({}, { strict: false }));
        const Patient = mongoose.model('Patient', new mongoose.Schema({}, { strict: false }));

        const targetDate = '2026-04-10';
        const start = moment.tz(targetDate, 'America/Sao_Paulo').startOf('day').utc().toDate();
        const end = moment.tz(targetDate, 'America/Sao_Paulo').endOf('day').utc().toDate();

        console.log('\n🔍 Auditando atendimentos do dia:', targetDate);

        const appointments = await Appointment.find({
            date: { $gte: start, $lt: end },
            operationalStatus: { $in: ['confirmed', 'completed', 'scheduled'] }
        }).lean();

        console.log(`Total de atendimentos: ${appointments.length}\n`);

        // Mostrar todos os atendimentos com seus dados de paciente
        for (const a of appointments) {
            let patientName = 'N/A';
            
            if (a.patient) {
                const patient = await Patient.findById(a.patient).lean();
                patientName = patient?.fullName || 'N/A (paciente não encontrado)';
            }

            console.log(`${a.time} | ${a.patientName || 'N/A'} | ${patientName} | ${a.serviceType || 'session'} | ${a.billingType || 'particular'} | R$ ${a.sessionValue || 0}`);
        }

        // Listar problemas
        console.log('\n\n⚠️ PROBLEMAS ENCONTRADOS:');
        const problemas = appointments.filter(a => !a.patientName || a.patientName === 'N/A');
        if (problemas.length === 0) {
            console.log('Nenhum problema encontrado! Todos têm patientName.');
        } else {
            for (const p of problemas) {
                const patient = p.patient ? await Patient.findById(p.patient).lean() : null;
                console.log(`\n- Horário: ${p.time}`);
                console.log(`  patientName: ${p.patientName || 'N/A'}`);
                console.log(`  patient ID: ${p.patient || 'N/A'}`);
                console.log(`  Nome do paciente (lookup): ${patient?.fullName || 'N/A'}`);
                console.log(`  billingType: ${p.billingType}`);
                console.log(`  insuranceProvider: ${p.insuranceProvider}`);
            }
        }

        await mongoose.disconnect();
    } catch (err) {
        console.error('Erro:', err.message);
        process.exit(1);
    }
}

auditAppointments();
