// scripts/reconciliacao-convenio-backfill.js
// ============================================================
// BACKFILL: Criar Payment para sessões de CONVÊNIO completed
// que NÃO têm Payment vinculado.
//
// Contexto: O V2 foi corrigido em 16/04/2026 para criar Payment
// ao completar sessão de convênio. Sessões anteriores ficaram
// sem Payment → "buraco negro" no dashboard financeiro.
//
// Uso: node scripts/reconciliacao-convenio-backfill.js [dry-run]
// ============================================================

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import moment from 'moment-timezone';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import Payment from '../models/Payment.js';

dotenv.config();

const TIMEZONE = 'America/Sao_Paulo';
const DRY_RUN = process.argv.includes('dry-run');

// 🎯 FILTRO: apenas MARÇO/2026 (legado contaminado)
const MARCO_START = moment.tz('2026-03-01', TIMEZONE).startOf('day').toDate();
const MARCO_END = moment.tz('2026-03-31', TIMEZONE).endOf('day').toDate();

async function main() {
    console.log(`[Backfill Convenio] Iniciando... ${DRY_RUN ? '(DRY-RUN)' : '(EXECUÇÃO REAL)'}`);
    console.log(`[Backfill Convenio] Período: ${moment(MARCO_START).format('YYYY-MM-DD')} → ${moment(MARCO_END).format('YYYY-MM-DD')}`);

    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!mongoUri) {
        throw new Error('MONGO_URI não encontrado no .env');
    }
    await mongoose.connect(mongoUri);
    console.log('[Backfill Convenio] Conectado ao MongoDB');

    // Buscar sessões de CONVÊNIO completed em MARÇO/2026 sem Payment vinculado
    // Session.date é ISODate → usar Date objects
    const sessionsSemPayment = await Session.find({
        status: 'completed',
        date: { $gte: MARCO_START, $lte: MARCO_END },
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

    console.log(`[Backfill Convenio] Encontradas ${sessionsSemPayment.length} sessões sem Payment`);

    let criados = 0;
    let skipped = 0;
    let skippedDuplicado = 0;
    let skippedSemValor = 0;
    let skippedSemAppointment = 0;
    let erros = 0;

    for (const session of sessionsSemPayment) {
        try {
            // Tentar achar o appointment vinculado
            const appointment = await Appointment.findOne({ session: session._id }).lean();

            if (!appointment) {
                console.log(`[SKIP-SEM-APPOINTMENT] Sessão ${session._id}: sem appointment vinculado`);
                skipped++;
                skippedSemAppointment++;
                continue;
            }

            // Verificar se já existe Payment vinculado ao appointment
            const existingPayment = await Payment.findOne({
                $or: [
                    { appointment: appointment._id },
                    { session: session._id }
                ],
                billingType: 'convenio'
            }).lean();

            if (existingPayment) {
                console.log(`[SKIP-DUPLICADO] Sessão ${session._id}: já existe Payment ${existingPayment._id}`);
                // Linkar na session se não estiver linkado
                if (!session.paymentId) {
                    if (!DRY_RUN) {
                        await Session.findByIdAndUpdate(session._id, { paymentId: existingPayment._id });
                    }
                    console.log(`  → Linkado session.paymentId = ${existingPayment._id}`);
                }
                skipped++;
                skippedDuplicado++;
                continue;
            }

            const sessionDate = moment(session.date).tz(TIMEZONE);
            const now = new Date();

            // Calcular valor com fallback hierárquico
            const valor = session.package?.insuranceGrossAmount
                || session.sessionValue
                || appointment.sessionValue
                || appointment.insuranceValue
                || 0;

            // ⚠️ PROTEÇÃO: log detalhado quando valor vem de fallback
            if (!session.sessionValue && !session.package?.insuranceGrossAmount) {
                console.log(`[AVISO-VALOR] Sessão ${session._id}: usando fallback (appointment.sessionValue=${appointment.sessionValue}, insuranceValue=${appointment.insuranceValue})`);
            }

            if (valor === 0) {
                console.log(`[SKIP-SEM-VALOR] Sessão ${session._id}: valor zerado (sessionValue=${session.sessionValue}, insuranceValue=${appointment.insuranceValue})`);
                skipped++;
                skippedSemValor++;
                continue;
            }

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
                    authorizationCode: session.authorizationCode || appointment.authorizationCode || '',
                    status: 'pending_billing',
                    grossAmount: valor
                },
                serviceDate: sessionDate.format('YYYY-MM-DD'),
                description: `Sessão convênio realizada - ${appointment.patient?.fullName || 'Paciente'}`,
                appointment: appointment._id,
                session: session._id,
                kind: 'session_payment',
                createdAt: now,
                updatedAt: now
            };

            if (DRY_RUN) {
                console.log(`[DRY-RUN] Criaria Payment para sessão ${session._id}: R$ ${valor.toFixed(2)}`);
            } else {
                const payment = await Payment.create(paymentData);
                await Session.findByIdAndUpdate(session._id, { paymentId: payment._id });
                console.log(`[CRIADO] Payment ${payment._id} para sessão ${session._id}: R$ ${valor.toFixed(2)}`);
            }
            criados++;

        } catch (err) {
            console.error(`[ERRO] Sessão ${session._id}:`, err.message);
            erros++;
        }
    }

    console.log('\n========================================');
    console.log('[Backfill Convenio] RESUMO');
    console.log('========================================');
    console.log(`Total analisado:     ${sessionsSemPayment.length}`);
    console.log(`Criados:             ${criados}`);
    console.log(`Skipped (total):     ${skipped}`);
    console.log(`  └─ Duplicados:     ${skippedDuplicado}`);
    console.log(`  └─ Sem valor:      ${skippedSemValor}`);
    console.log(`  └─ Sem appointment: ${skippedSemAppointment}`);
    console.log(`Erros:               ${erros}`);
    console.log(`Modo:                ${DRY_RUN ? 'DRY-RUN (nada foi alterado)' : 'EXECUÇÃO REAL'}`);
    console.log('========================================');

    await mongoose.disconnect();
    process.exit(0);
}

main().catch(err => {
    console.error('[Backfill Convenio] Erro fatal:', err);
    process.exit(1);
});
