// 🔍 BUSCAR: Appointments SCHEDULED que deveriam ser COMPLETED
// Busca appointments "scheduled" mas que têm Session completed ou Payment pago
//
// Uso: node buscar-scheduled-que-deveriam-ser-completed.js

import mongoose from 'mongoose';
import dotenv from 'dotenv';

import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

async function buscar() {
    console.log('========================================');
    console.log('🔍 BUSCA: Scheduled → Deveriam ser Completed');
    console.log('========================================\n');

    await mongoose.connect(MONGO_URI);
    console.log('✅ Conectado ao MongoDB\n');

    // Buscar todos appointments scheduled
    const appointments = await Appointment.find({
        operationalStatus: 'scheduled',
        isDeleted: { $ne: true }
    }).sort({ date: -1 });

    console.log(`📦 ${appointments.length} appointments "scheduled"\n`);

    const paraCorrigir = [];

    for (const apt of appointments) {
        const aptId = apt._id.toString();
        
        // Buscar Session
        const session = await Session.findOne({
            $or: [
                { appointmentId: apt._id },
                { _id: apt.session }
            ],
            isDeleted: { $ne: true }
        });

        // Buscar Payment
        const payment = await Payment.findOne({
            $or: [
                { appointmentId: apt._id },
                { _id: apt.payment }
            ]
        });

        const sessionCompleted = session && ['completed', 'finished', 'done'].includes(session.status);
        const paymentPago = payment && ['paid', 'completed'].includes(payment.status);

        // Se tem evidência de que foi concluído
        if (sessionCompleted || paymentPago) {
            paraCorrigir.push({
                aptId,
                patient: apt.patient?.toString(),
                date: apt.date,
                time: apt.time,
                motivo: sessionCompleted ? 'Session completed' : 'Payment pago',
                sessionId: session?._id?.toString(),
                sessionStatus: session?.status,
                paymentId: payment?._id?.toString(),
                paymentStatus: payment?.status
            });
        }
    }

    console.log(`❌ Inconsistências: ${paraCorrigir.length}\n`);

    if (paraCorrigir.length > 0) {
        paraCorrigir.forEach((item, i) => {
            console.log(`${i + 1}. ${item.aptId}`);
            console.log(`   Data: ${item.date?.toISOString().split('T')[0]} ${item.time}`);
            console.log(`   Motivo: ${item.motivo}`);
            console.log(`   Session: ${item.sessionId || 'N/A'} (${item.sessionStatus || 'N/A'})`);
            console.log(`   Payment: ${item.paymentId || 'N/A'} (${item.paymentStatus || 'N/A'})`);
            console.log('');
        });

        // Comando para corrigir
        console.log('// Comando MongoDB para corrigir:\n');
        console.log('const ids = [');
        paraCorrigir.forEach(item => {
            console.log(`  ObjectId("${item.aptId}"), // ${item.date?.toISOString().split('T')[0]}`);
        });
        console.log('];\n');
        console.log('db.appointments.updateMany(');
        console.log('  { _id: { $in: ids } },');
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
