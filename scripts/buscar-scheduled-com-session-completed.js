// 🔍 BUSCAR: Appointments SCHEDULED com Session COMPLETED
// Isso indica inconsistência - atendimento aconteceu mas status não atualizou
//
// Uso: node buscar-scheduled-com-session-completed.js

import mongoose from 'mongoose';
import dotenv from 'dotenv';

import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

async function buscar() {
    console.log('========================================');
    console.log('🔍 BUSCA: Scheduled com Session Completed');
    console.log('========================================\n');

    await mongoose.connect(MONGO_URI);
    console.log('✅ Conectado ao MongoDB\n');

    // Buscar appointments scheduled
    const appointments = await Appointment.find({
        operationalStatus: 'scheduled',
        isDeleted: { $ne: true }
    }).sort({ date: -1 }).limit(500);

    console.log(`📦 ${appointments.length} appointments "scheduled" encontrados\n`);

    const inconsistencias = [];

    for (const apt of appointments) {
        const session = await Session.findOne({
            $or: [
                { appointmentId: apt._id },
                { _id: apt.session }
            ],
            status: 'completed',
            isDeleted: { $ne: true }
        });

        if (session) {
            inconsistencias.push({
                aptId: apt._id.toString(),
                patient: apt.patient?.toString(),
                date: apt.date,
                time: apt.time,
                sessionId: session._id.toString(),
                sessionDate: session.date,
                sessionEvolution: session.evolution?.substring(0, 50) || 'Sem evolução'
            });
        }
    }

    console.log(`❌ Inconsistências encontradas: ${inconsistencias.length}\n`);

    if (inconsistencias.length > 0) {
        console.log('Lista:');
        inconsistencias.forEach((item, i) => {
            console.log(`\n${i + 1}. ${item.aptId}`);
            console.log(`   Paciente: ${item.patient}`);
            console.log(`   Data: ${item.date?.toISOString().split('T')[0]} ${item.time}`);
            console.log(`   Session: ${item.sessionId}`);
            console.log(`   Evolução: ${item.sessionEvolution}...`);
        });

        console.log('\n\n// Comando MongoDB para corrigir:\n');
        console.log('const idsParaCorrigir = [');
        inconsistencias.forEach(item => {
            console.log(`  ObjectId("${item.aptId}"), // ${item.date?.toISOString().split('T')[0]}`);
        });
        console.log('];\n');
        console.log('db.appointments.updateMany(');
        console.log('  { _id: { $in: idsParaCorrigir } },');
        console.log('  { $set: { operationalStatus: "completed" } }');
        console.log(');');
    }

    await mongoose.disconnect();
    console.log('\n👋 Done!');
    process.exit(0);
}

buscar().catch(err => {
    console.error('💥 Erro:', err);
    process.exit(1);
});
