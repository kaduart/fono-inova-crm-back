/**
 * 🔍 Diagnóstico: Payment ID fantasma
 * Roda: node scripts/diagnose-missing-payment.js <paymentId>
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const paymentId = process.argv[2];
if (!paymentId) {
    console.error('❌ Uso: node scripts/diagnose-missing-payment.js <paymentId>');
    process.exit(1);
}

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!MONGO_URI) {
    console.error('❌ MONGODB_URI não configurada');
    process.exit(1);
}

async function main() {
    await mongoose.connect(MONGO_URI);
    const dbName = mongoose.connection.db.databaseName;
    console.log(`🔌 Conectado ao banco: ${dbName}\n`);

    const Payment = mongoose.model('Payment', new mongoose.Schema({}, { strict: false }));
    const PaymentsView = mongoose.model('PaymentsView', new mongoose.Schema({}, { strict: false }));
    const Appointment = mongoose.model('Appointment', new mongoose.Schema({}, { strict: false }));
    const Session = mongoose.model('Session', new mongoose.Schema({}, { strict: false }));
    const EventStore = mongoose.model('EventStore', new mongoose.Schema({}, { strict: false }));

    // 1. Payment direto
    console.log(`━━ 1. PAYMENTS collection ━━`);
    const payment = await Payment.findById(paymentId).lean();
    console.log(payment ? '✅ ENCONTRADO' : '❌ NÃO ENCONTRADO');
    if (payment) console.log('  ', JSON.stringify(payment, null, 2).substring(0, 500));

    // 2. PaymentsView (projection)
    console.log(`\n━━ 2. PAYMENTSVIEW projection ━━`);
    const view = await PaymentsView.findById(paymentId).lean();
    console.log(view ? '✅ ENCONTRADO' : '❌ NÃO ENCONTRADO');
    if (view) console.log('  ', JSON.stringify(view, null, 2).substring(0, 500));

    // 3. Appointment por ID direto
    console.log(`\n━━ 3. APPOINTMENT por ID ━━`);
    const appointment = await Appointment.findById(paymentId).lean();
    console.log(appointment ? '✅ ENCONTRADO' : '❌ NÃO ENCONTRADO');
    if (appointment) {
        console.log('   operationalStatus:', appointment.operationalStatus);
        console.log('   paymentStatus:', appointment.paymentStatus);
        console.log('   payment:', appointment.payment?.toString?.());
        console.log('   session:', appointment.session?.toString?.());
        console.log('   package:', appointment.package?.toString?.());
    }

    // 4. Appointments que referenciam esse payment
    console.log(`\n━━ 4. APPOINTMENTS com payment = ${paymentId} ━━`);
    const apptsWithPayment = await Appointment.find({ payment: paymentId }).lean();
    console.log(apptsWithPayment.length > 0 ? `✅ ${apptsWithPayment.length} encontrado(s)` : '❌ Nenhum');

    // 5. Sessions que referenciam esse payment
    console.log(`\n━━ 5. SESSIONS com payment = ${paymentId} ━━`);
    const sessionsWithPayment = await Session.find({ payment: paymentId }).lean();
    console.log(sessionsWithPayment.length > 0 ? `✅ ${sessionsWithPayment.length} encontrada(s)` : '❌ Nenhuma');

    // 6. Event Store
    console.log(`\n━━ 6. EVENT STORE ━━`);
    const events = await EventStore.find({
        $or: [
            { 'payload.paymentId': paymentId },
            { aggregateId: paymentId }
        ]
    }).sort({ timestamp: -1 }).limit(5).lean();
    console.log(events.length > 0 ? `✅ ${events.length} evento(s)` : '❌ Nenhum');

    await mongoose.disconnect();
    console.log('\n✅ Diagnóstico completo');
}

main().catch(err => {
    console.error('❌ Erro:', err.message);
    process.exit(1);
});
