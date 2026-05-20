/**
 * ============================================================
 * BACKFILL: Criar Payment pendente para sessões de CONVÊNIO
 * ============================================================
 *
 * Sessões de convênio `completed` devem ter um Payment vinculado
 * com status='pending' para aparecerem em "Convênio a Receber".
 *
 * Uso:
 *   node scripts/backfill-convenio-payments.js 2026 05 --dry-run
 *   node scripts/backfill-convenio-payments.js 2026 05
 * ============================================================
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import moment from 'moment-timezone';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import Payment from '../models/Payment.js';

dotenv.config();

const TIMEZONE = 'America/Sao_Paulo';
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
    const [,, yearArg, monthArg] = process.argv;
    const year = parseInt(yearArg || moment().year());
    const month = parseInt(monthArg || moment().month() + 1);

    const start = moment.tz([year, month - 1, 1], TIMEZONE).startOf('day').toDate();
    const end = moment.tz([year, month - 1, 1], TIMEZONE).endOf('month').endOf('day').toDate();

    console.log(`[Backfill Convenio] ${DRY_RUN ? 'DRY-RUN' : 'EXECUÇÃO REAL'}`);
    console.log(`[Backfill Convenio] Período: ${moment(start).format('YYYY-MM-DD')} → ${moment(end).format('YYYY-MM-DD')}`);

    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!mongoUri) throw new Error('MONGO_URI não encontrado');
    await mongoose.connect(mongoUri);
    console.log('[Backfill Convenio] MongoDB conectado\n');

    // Buscar sessões de convênio completed SEM payment vinculado
    const sessionsSemPayment = await Session.find({
        status: 'completed',
        date: { $gte: start, $lte: end },
        $and: [
            {
                $or: [
                    { paymentMethod: 'convenio' },
                    { insuranceGuide: { $exists: true, $ne: null } }
                ]
            },
            {
                $or: [
                    { paymentId: { $exists: false } },
                    { paymentId: null }
                ]
            }
        ]
    }).lean();

    console.log(`[Backfill Convenio] ${sessionsSemPayment.length} sessões sem Payment\n`);

    let criados = 0, skipped = 0, erros = 0;

    for (const session of sessionsSemPayment) {
        try {
            const appointment = await Appointment.findOne({ session: session._id }).lean();

            if (!appointment) {
                console.log(`[SKIP] ${session._id}: sem appointment`);
                skipped++;
                continue;
            }

            // Idempotência: verificar se já existe payment para esta session
            const existing = await Payment.findOne({
                $or: [{ appointment: appointment._id }, { session: session._id }],
                billingType: 'convenio'
            }).lean();

            if (existing) {
                console.log(`[SKIP] ${session._id}: já existe Payment ${existing._id}`);
                if (!session.paymentId && !DRY_RUN) {
                    await Session.findByIdAndUpdate(session._id, { paymentId: existing._id });
                    console.log(`  → Linkado session.paymentId`);
                }
                skipped++;
                continue;
            }

            const valor = session.sessionValue
                || appointment.sessionValue
                || appointment.insuranceValue
                || 0;

            if (valor === 0) {
                console.log(`[SKIP] ${session._id}: valor zerado`);
                skipped++;
                continue;
            }

            const sessionDate = moment(session.date).tz(TIMEZONE);

            const paymentData = {
                patient: session.patient || appointment.patient,
                doctor: session.doctor || appointment.doctor,
                amount: valor,
                status: 'pending',
                type: 'service',
                serviceType: 'session',
                paymentMethod: 'convenio',
                paymentDate: sessionDate.format('YYYY-MM-DD'),
                billingType: 'convenio',
                insurance: {
                    provider: session.insuranceProvider || appointment.insuranceProvider || 'Convênio',
                    status: 'pending_billing',
                    grossAmount: valor
                },
                serviceDate: sessionDate.format('YYYY-MM-DD'),
                description: `Sessão convênio realizada - ${appointment.patient?.fullName || 'Paciente'}`,
                appointment: appointment._id,
                session: session._id,
                kind: 'session_payment',
                createdAt: new Date(),
                updatedAt: new Date()
            };

            if (DRY_RUN) {
                console.log(`[DRY-RUN] Criaria: ${session._id} → R$ ${valor.toFixed(2)}`);
            } else {
                const payment = await Payment.create(paymentData);
                await Session.findByIdAndUpdate(session._id, { paymentId: payment._id });
                console.log(`[CRIADO] ${payment._id} para ${session._id}: R$ ${valor.toFixed(2)}`);
            }
            criados++;

        } catch (err) {
            console.error(`[ERRO] ${session._id}:`, err.message);
            erros++;
        }
    }

    console.log('\n========================================');
    console.log('RESUMO');
    console.log('========================================');
    console.log(`Analisadas:  ${sessionsSemPayment.length}`);
    console.log(`Criados:     ${criados}`);
    console.log(`Skipped:     ${skipped}`);
    console.log(`Erros:       ${erros}`);
    console.log(`Modo:        ${DRY_RUN ? 'DRY-RUN' : 'REAL'}`);
    console.log('========================================');

    await mongoose.disconnect();
    process.exit(0);
}

main().catch(err => {
    console.error('[ERRO FATAL]', err);
    process.exit(1);
});
