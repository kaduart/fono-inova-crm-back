// scripts/reconciliacao-abril-backfill.js
// ============================================================
// BACKFILL: Criar Payments para sessions de ABRIL/2026 sem Payment
//
// Contexto: Write path V2 não criava Payment para sessions paid via
// balance ou quando o fluxo de pagamento era externo.
//
// Uso: node scripts/reconciliacao-abril-backfill.js [dry-run]
// ============================================================

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import moment from 'moment-timezone';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import Patient from '../models/Patient.js';

dotenv.config();

const TIMEZONE = 'America/Sao_Paulo';
const DRY_RUN = process.argv.includes('dry-run');

const ABRIL_START = moment.tz('2026-04-01', TIMEZONE).startOf('day').toDate();
const ABRIL_END = moment.tz('2026-04-30', TIMEZONE).endOf('day').toDate();

async function main() {
    console.log(`[Abril Backfill] Iniciando... ${DRY_RUN ? '(DRY-RUN)' : '(EXECUÇÃO REAL)'}`);

    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!mongoUri) throw new Error('MONGO_URI não encontrado no .env');
    await mongoose.connect(mongoUri);
    console.log('[Abril Backfill] Conectado ao MongoDB');

    // Buscar todas as sessions completed de abril
    const sessions = await Session.find({
        status: 'completed',
        date: { $gte: ABRIL_START, $lte: ABRIL_END }
    }).lean();

    const sessionIds = sessions.map(s => s._id.toString());

    // Verificar quais já têm Payment vinculado
    const linkedPayments = await Payment.find({ session: { $in: sessionIds } }).select('session status').lean();
    const linkedSessionIds = new Set(linkedPayments.map(p => p.session?.toString()).filter(Boolean));

    const unlinkedSessions = sessions.filter(s => !linkedSessionIds.has(s._id.toString()));

    console.log(`[Abril Backfill] Total sessions abril: ${sessions.length}`);
    console.log(`[Abril Backfill] Sessions com Payment: ${linkedSessionIds.size}`);
    console.log(`[Abril Backfill] Sessions SEM Payment: ${unlinkedSessions.length}`);

    let criadosPaid = 0;
    let criadosPending = 0;
    let skipped = 0;
    let erros = 0;

    for (const session of unlinkedSessions) {
        try {
            const sessionId = session._id.toString();
            const patientId = session.patient;
            const appointmentId = session.appointmentId;
            const sessionValue = session.sessionValue || 0;
            const isPaid = session.isPaid === true;
            const paymentStatus = session.paymentStatus;
            const paymentMethod = session.paymentMethod || 'pix';
            const paymentOrigin = session.paymentOrigin;

            // Pular sessions com valor zero
            if (sessionValue <= 0) {
                console.log(`[SKIP] Session ${sessionId}: valor zero`);
                skipped++;
                continue;
            }

            // Determinar status do Payment
            let paymentStatusNew = 'pending';
            let paidAt = null;
            let financialDate = session.date;

            if (isPaid || paymentStatus === 'paid' || paymentStatus === 'package_paid') {
                paymentStatusNew = 'paid';
                paidAt = session.paidAt || session.date;
                financialDate = session.paidAt || session.date;
            } else if (paymentStatus === 'pending' || paymentStatus === 'unpaid') {
                paymentStatusNew = 'pending';
            } else {
                // Caso não reconhecido, assume pending
                paymentStatusNew = 'pending';
            }

            // Buscar dados do paciente
            let patient = null;
            if (patientId) {
                patient = await Patient.findById(patientId).select('fullName').lean();
            }

            // Buscar appointment para ter data/hora correta
            let appointment = null;
            if (appointmentId) {
                appointment = await Appointment.findById(appointmentId).select('date time').lean();
            }

            const dataRef = appointment?.date || session.date;
            const horaRef = appointment?.time || session.time || '';

            if (DRY_RUN) {
                console.log(`[DRY-RUN] Criaria Payment para session ${sessionId}: ${patient?.fullName || 'Paciente'} | R$ ${sessionValue} | ${paymentStatusNew} | data=${moment(dataRef).tz(TIMEZONE).format('YYYY-MM-DD')}`);
            } else {
                const paymentDoc = await Payment.create({
                    patient: patientId,
                    amount: sessionValue,
                    status: paymentStatusNew,
                    type: 'service',
                    serviceType: 'session',
                    paymentMethod: paymentMethod,
                    paymentDate: dataRef,
                    paidAt: paidAt,
                    financialDate: financialDate,
                    description: `Sessão ${paymentStatusNew === 'paid' ? 'realizada' : 'pendente'} - ${patient?.fullName || 'Paciente'}`,
                    appointment: appointmentId,
                    session: sessionId,
                    kind: 'session_payment',
                    billingType: paymentMethod === 'convenio' ? 'convenio' : 'particular',
                    createdAt: new Date(),
                    updatedAt: new Date()
                });
                console.log(`[CRIADO] Payment ${paymentDoc._id} para session ${sessionId}: ${patient?.fullName || 'Paciente'} | R$ ${sessionValue} | ${paymentStatusNew}`);
            }

            if (paymentStatusNew === 'paid') {
                criadosPaid++;
            } else {
                criadosPending++;
            }

        } catch (err) {
            console.error(`[ERRO] Session ${session._id}:`, err.message);
            erros++;
        }
    }

    console.log('\n========================================');
    console.log('[Abril Backfill] RESUMO');
    console.log('========================================');
    console.log(`Sessions sem Payment:   ${unlinkedSessions.length}`);
    console.log(`Payments criados (paid):  ${criadosPaid}`);
    console.log(`Payments criados (pend):  ${criadosPending}`);
    console.log(`Skipped (valor zero):   ${skipped}`);
    console.log(`Erros:                  ${erros}`);
    console.log(`Modo:                   ${DRY_RUN ? 'DRY-RUN' : 'EXECUÇÃO REAL'}`);
    console.log('========================================');

    await mongoose.disconnect();
    process.exit(0);
}

main().catch(err => {
    console.error('[Abril Backfill] Erro fatal:', err);
    process.exit(1);
});
