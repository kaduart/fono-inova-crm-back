/**
 * 🔍 Diagnóstico: Pipeline de criação de appointment
 * Roda: node scripts/diagnose-appointment-pipeline.js <appointmentId>
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const appointmentId = process.argv[2];
if (!appointmentId) {
    console.error('❌ Uso: node scripts/diagnose-appointment-pipeline.js <appointmentId>');
    process.exit(1);
}

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!MONGO_URI) {
    console.error('❌ MONGODB_URI não configurada');
    process.exit(1);
}

async function main() {
    await mongoose.connect(MONGO_URI);
    console.log(`🔌 Conectado ao banco: ${mongoose.connection.db.databaseName}\n`);

    const EventStore = mongoose.model('EventStore', new mongoose.Schema({}, { strict: false }));
    const Appointment = mongoose.model('Appointment', new mongoose.Schema({}, { strict: false }));
    const Session = mongoose.model('Session', new mongoose.Schema({}, { strict: false }));
    const Payment = mongoose.model('Payment', new mongoose.Schema({}, { strict: false }));

    // 1. Busca appointment
    console.log(`━━ 1. APPOINTMENT: ${appointmentId} ━━`);
    const appt = await Appointment.findById(appointmentId).lean();
    if (!appt) {
        console.log('❌ Appointment não encontrado');
        await mongoose.disconnect();
        return;
    }
    console.log('✅ ENCONTRADO');
    console.log('   operationalStatus:', appt.operationalStatus);
    console.log('   paymentStatus:', appt.paymentStatus);
    console.log('   serviceType:', appt.serviceType);
    console.log('   package:', appt.package?.toString?.() || 'null');
    console.log('   payment:', appt.payment?.toString?.() || 'null');
    console.log('   session:', appt.session?.toString?.() || 'null');
    console.log('   createdAt:', appt.createdAt);

    // 2. Busca session se existir
    if (appt.session) {
        console.log(`\n━━ 2. SESSION: ${appt.session} ━━`);
        const session = await Session.findById(appt.session).lean();
        console.log(session ? '✅ ENCONTRADA' : '❌ NÃO ENCONTRADA');
        if (session) {
            console.log('   status:', session.status);
            console.log('   payment:', session.payment?.toString?.() || 'null');
        }
    }

    // 3. Busca payment se existir
    if (appt.payment) {
        console.log(`\n━━ 3. PAYMENT: ${appt.payment} ━━`);
        const payment = await Payment.findById(appt.payment).lean();
        console.log(payment ? '✅ ENCONTRADO' : '❌ NÃO ENCONTRADO');
        if (payment) {
            console.log('   status:', payment.status);
            console.log('   amount:', payment.amount);
        }
    }

    // 4. Event Store - todos os eventos relacionados
    console.log(`\n━━ 4. EVENT STORE (pipeline) ━━`);
    const events = await EventStore.find({
        $or: [
            { aggregateId: appointmentId },
            { 'payload.appointmentId': appointmentId },
            { 'payload._id': appointmentId }
        ]
    }).sort({ timestamp: 1 }).lean();

    if (events.length === 0) {
        console.log('❌ NENHUM EVENTO ENCONTRADO');
        console.log('   → Pipeline NUNCA rodou para esse appointment');
        console.log('   → Ou eventos foram limpados');
    } else {
        const expectedEvents = ['APPOINTMENT_CREATE_REQUESTED', 'APPOINTMENT_CREATED', 'SESSION_CREATED', 'PAYMENT_CREATED'];
        const foundTypes = events.map(e => e.eventType);
        
        console.log(`   ${events.length} evento(s) encontrado(s):`);
        events.forEach((e, i) => {
            const ts = e.timestamp ? new Date(e.timestamp).toISOString() : 'sem timestamp';
            console.log(`   ${i + 1}. ${e.eventType} | status=${e.status} | ${ts}`);
        });

        console.log('\n   Verificação do pipeline:');
        expectedEvents.forEach(type => {
            const found = foundTypes.includes(type);
            console.log(`   ${found ? '✅' : '❌'} ${type}`);
        });
    }

    // 5. Verifica se é de pacote
    console.log(`\n━━ 5. ANÁLISE ━━`);
    if (appt.package) {
        console.log('📦 Appointment é de PACOTE');
        console.log('   → NÃO deve ter payment individual');
        console.log('   → O payment é do pacote, não do agendamento');
    } else if (appt.serviceType === 'package_session') {
        console.log('📦 serviceType = package_session');
        console.log('   → Código antigo pode ter criado sem packageId');
    } else {
        console.log('📋 Appointment é AVULSO');
        if (!appt.payment && !appt.session) {
            console.log('   ❌ Pipeline quebrou: avulso SEM session e SEM payment');
        } else if (!appt.payment) {
            console.log('   ❌ Pipeline quebrou: avulso SEM payment');
        } else if (!appt.session) {
            console.log('   ❌ Pipeline quebrou: avulso SEM session');
        } else {
            console.log('   ✅ Pipeline completo');
        }
    }

    await mongoose.disconnect();
    console.log('\n✅ Diagnóstico completo');
}

main().catch(err => {
    console.error('❌ Erro:', err.message);
    process.exit(1);
});
