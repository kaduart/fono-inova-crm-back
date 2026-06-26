/**
 * 🔧 BACKFILL — Corrigir insurance.provider e patient em payments de convênio de abril/2026
 *
 * O backfill usa a sessão como fonte de verdade para:
 *   - patient (corrigir payments vinculados ao paciente errado)
 *   - insurance.provider (session.insuranceProvider / session.insuranceGuide.insurance / batch.insuranceProvider)
 *
 * Uso:
 *   node scripts/backfill-insurance-provider-abril-2026.js dry-run   (padrão)
 *   node scripts/backfill-insurance-provider-abril-2026.js apply
 */

import mongoose from 'mongoose';
import moment from 'moment-timezone';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });

import '../models/index.js';
import InsuranceBatch from '../models/InsuranceBatch.js';

const Payment = mongoose.model('Payment');
const Session = mongoose.model('Session');
const Appointment = mongoose.model('Appointment');

const TIMEZONE = 'America/Sao_Paulo';

async function connectDb() {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    await mongoose.connect(uri);
    console.log(`🔗 Conectado: ${uri.split('@').pop()?.split('/').shift()}\n`);
}

function fmtBrl(v) {
    if (v == null) return '—';
    return `R$ ${Number(v).toFixed(2).replace('.', ',')}`;
}

async function run() {
    const mode = process.argv[2] || 'dry-run';
    const apply = mode === 'apply';

    const start = moment.tz('2026-04-01', TIMEZONE).startOf('day').utc().toDate();
    const end = moment.tz('2026-04-30', TIMEZONE).endOf('day').utc().toDate();

    // Busca sessions de convênio realizadas em abril/2026
    const sessions = await Session.find({
        date: { $gte: start, $lte: end },
        status: 'completed',
        $or: [
            { paymentMethod: 'convenio' },
            { paymentOrigin: 'convenio' },
            { insuranceGuide: { $exists: true, $ne: null } }
        ]
    }).populate('patient', 'fullName')
      .populate('insuranceGuide', 'number insurance specialty')
      .lean();

    const sessionMap = Object.fromEntries(sessions.map(s => [String(s._id), s]));
    const sessionIds = sessions.map(s => String(s._id));

    // Busca payments vinculados a essas sessions
    const payments = await Payment.find({
        $or: [
            { session: { $in: sessionIds.map(id => new mongoose.Types.ObjectId(id)) } },
            { sessions: { $in: sessionIds.map(id => new mongoose.Types.ObjectId(id)) } }
        ],
        billingType: 'convenio'
    }).populate('patient', 'fullName')
      .populate('session', 'date insuranceProvider insuranceGuide patient')
      .lean();

    // Busca appointments vinculados
    const appointmentIds = sessions.map(s => s.appointmentId || s.appointment).filter(Boolean);
    const appointments = await Appointment.find({
        _id: { $in: appointmentIds.map(id => new mongoose.Types.ObjectId(id)) }
    }).populate('patient', 'fullName').lean();
    const appointmentMap = Object.fromEntries(appointments.map(a => [String(a._id), a]));

    // Busca batches vinculados
    const batches = await InsuranceBatch.find({
        'sessions.session': { $in: sessionIds.map(id => new mongoose.Types.ObjectId(id)) }
    }).lean();
    const batchBySession = {};
    for (const batch of batches) {
        for (const s of batch.sessions || []) {
            if (s.session) batchBySession[String(s.session)] = batch;
        }
    }

    console.log(`📅 Período: abril/2026`);
    console.log(`💾 Payments encontrados: ${payments.length}`);
    console.log(`🛠️  Modo: ${apply ? 'APLICAR ALTERAÇÕES' : 'DRY-RUN (simulação)'}`);
    console.log('');

    const toFix = [];

    for (const p of payments) {
        const relatedSessionIds = [];
        if (p.session) relatedSessionIds.push(String(p.session._id || p.session));
        if (Array.isArray(p.sessions)) relatedSessionIds.push(...p.sessions.map(String));

        // Usa a primeira session relacionada como fonte de verdade
        const sessionId = relatedSessionIds[0];
        const session = sessionMap[sessionId];
        if (!session) continue;

        const appointment = appointmentMap[String(session.appointmentId || session.appointment)];
        const batch = batchBySession[sessionId];

        // Provider esperado
        const expectedProvider =
            session.insuranceProvider ||
            session.insuranceGuide?.insurance ||
            appointment?.insuranceProvider ||
            batch?.insuranceProvider ||
            p.insurance?.provider ||
            null;

        // Patient esperado
        const expectedPatientId = session.patient?._id?.toString();

        const currentProvider = p.insurance?.provider || null;
        const currentPatientId = p.patient?._id?.toString();

        const providerMismatch = expectedProvider && currentProvider !== expectedProvider;
        const patientMismatch = expectedPatientId && currentPatientId !== expectedPatientId;

        if (providerMismatch || patientMismatch) {
            toFix.push({
                paymentId: p._id.toString(),
                sessionId,
                date: moment(session.date).tz(TIMEZONE).format('DD/MM/YYYY'),
                patientNameSession: session.patient?.fullName,
                patientNamePayment: p.patient?.fullName,
                currentProvider,
                expectedProvider,
                currentPatientId,
                expectedPatientId,
                amount: p.amount
            });
        }
    }

    if (toFix.length === 0) {
        console.log('✅ Nenhuma inconsistência encontrada.');
        await mongoose.disconnect();
        return;
    }

    console.log(`⚠️  ${toFix.length} payment(s) com inconsistência:`);
    console.log('');

    for (const item of toFix) {
        console.log(`Payment: ${item.paymentId.slice(-8)} | Session: ${item.sessionId.slice(-6)} | ${item.date}`);
        console.log(`  Paciente session : ${item.patientNameSession} (${item.expectedPatientId?.slice(-6)})`);
        console.log(`  Paciente payment : ${item.patientNamePayment} (${item.currentPatientId?.slice(-6)})`);
        console.log(`  Provider atual   : ${item.currentProvider || '—'}`);
        console.log(`  Provider correto : ${item.expectedProvider || '—'}`);
        console.log(`  Valor            : ${fmtBrl(item.amount)}`);
        console.log('');
    }

    if (!apply) {
        console.log(`ℹ️  Para aplicar as correções, rode:`);
        console.log(`   node scripts/backfill-insurance-provider-abril-2026.js apply`);
        await mongoose.disconnect();
        return;
    }

    // Aplica correções
    console.log('🚀 Aplicando correções...');
    let updated = 0;
    for (const item of toFix) {
        const setOps = {};
        if (item.expectedProvider) {
            setOps['insurance.provider'] = item.expectedProvider;
        }
        if (item.expectedPatientId) {
            setOps.patient = new mongoose.Types.ObjectId(item.expectedPatientId);
        }

        const result = await Payment.updateOne(
            { _id: new mongoose.Types.ObjectId(item.paymentId) },
            { $set: setOps }
        );
        if (result.modifiedCount > 0) updated++;
    }

    console.log(`✅ ${updated} payment(s) corrigido(s).`);
    await mongoose.disconnect();
}

connectDb().then(run).catch(err => {
    console.error('💥 Erro:', err.message);
    console.error(err.stack);
    process.exit(1);
});
