// scripts/reconciliacao-particular-orphans.js
// ============================================================
// RECONCILIAÇÃO: Limpar payments PARTICULAR "pending" órfãos
//
// Contexto: V1 criava Payment pending ao agendar. V2 completa
// a sessão e cria/atualiza Payment para paid. O Payment antigo
// do V1 ficou órfão como "pending", gerando débito fantasma.
//
// Uso: node scripts/reconciliacao-particular-orphans.js [dry-run]
// ============================================================

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import moment from 'moment-timezone';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';

dotenv.config();

const TIMEZONE = 'America/Sao_Paulo';
const DRY_RUN = process.argv.includes('dry-run');

// 🎯 FILTRO: apenas MARÇO/2026 (legado contaminado)
// Payment.serviceDate e paymentDate são strings 'YYYY-MM-DD'
const MARCO_START_STR = '2026-03-01';
const MARCO_END_STR = '2026-03-31';

async function main() {
    console.log(`[Reconciliação Particular] Iniciando... ${DRY_RUN ? '(DRY-RUN)' : '(EXECUÇÃO REAL)'}`);
    console.log(`[Reconciliação Particular] Período: ${MARCO_START_STR} → ${MARCO_END_STR}`);

    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!mongoUri) {
        throw new Error('MONGO_URI não encontrado no .env');
    }
    await mongoose.connect(mongoUri);
    console.log('[Reconciliação Particular] Conectado ao MongoDB');

    // Buscar payments particular pending de MARÇO/2026
    // Payment.serviceDate e paymentDate são strings → usar strings no filtro
    const pendingPayments = await Payment.find({
        status: 'pending',
        amount: { $gt: 0 },
        $and: [
            {
                $or: [
                    { billingType: 'particular' },
                    { billingType: { $exists: false }, paymentMethod: { $ne: 'convenio' } }
                ]
            },
            {
                $or: [
                    { serviceDate: { $gte: MARCO_START_STR, $lte: MARCO_END_STR } },
                    { paymentDate: { $gte: MARCO_START_STR, $lte: MARCO_END_STR } }
                ]
            }
        ]
    }).lean();

    console.log(`[Reconciliação Particular] Total payments pending: ${pendingPayments.length}`);

    let cancelados = 0;
    let canceladosComPaidSibling = 0;
    let canceladosMesmoDia = 0;
    let atualizados = 0;
    let atualizadosSessionPaga = 0;
    let atualizadosAppointmentPago = 0;
    let mantidos = 0;
    let erros = 0;

    for (const p of pendingPayments) {
        try {
            const sessionId = p.session?.toString?.() || p.sessionId;
            const appointmentId = p.appointment?.toString?.() || p.appointmentId;
            const patientId = p.patient?.toString?.() || p.patientId;

            // Estratégia 1: Verificar se existe outro Payment PAID para a mesma session
            if (sessionId) {
                const paidSibling = await Payment.findOne({
                    _id: { $ne: p._id },
                    $or: [
                        { session: sessionId },
                        { sessionId: sessionId }
                    ],
                    status: { $in: ['paid', 'completed', 'confirmed'] }
                }).lean();

                if (paidSibling) {
                    console.log(`[DUPLICADO] Payment ${p._id} (pending R$ ${p.amount}) → session ${sessionId} já tem Payment paid ${paidSibling._id}`);
                    if (!DRY_RUN) {
                        await Payment.findByIdAndUpdate(p._id, {
                            $set: {
                                status: 'canceled',
                                notes: `${p.notes || ''} [RECONCILIAÇÃO: cancelado pois session já possui Payment paid ${paidSibling._id}]`.trim(),
                                updatedAt: new Date()
                            }
                        });
                    }
                    cancelados++;
                    canceladosComPaidSibling++;
                    continue;
                }
            }

            // Estratégia 2: Verificar se a Session está isPaid=true
            if (sessionId) {
                const session = await Session.findById(sessionId).lean();
                if (session && session.isPaid === true) {
                    console.log(`[SESSION PAGA] Payment ${p._id} (pending R$ ${p.amount}) → session ${sessionId} isPaid=true, mas sem Payment paid vinculado`);
                    if (!DRY_RUN) {
                        const newPaymentDate = session.paidAt ? moment(session.paidAt).format('YYYY-MM-DD') : moment().format('YYYY-MM-DD');
                        await Payment.findByIdAndUpdate(p._id, {
                            $set: {
                                status: 'paid',
                                paidAt: session.paidAt || new Date(),
                                paymentDate: newPaymentDate,
                                financialDate: null, // null → sistema usa paymentDate como fallback
                                notes: `${p.notes || ''} [RECONCILIAÇÃO: atualizado para paid pois session.isPaid=true]`.trim(),
                                updatedAt: new Date()
                            }
                        });
                    }
                    atualizados++;
                    atualizadosSessionPaga++;
                    continue;
                }
            }

            // Estratégia 3: Verificar se o Appointment está pago
            if (appointmentId) {
                const appointment = await Appointment.findById(appointmentId).lean();
                if (appointment && ['paid', 'completed', 'confirmed'].includes(appointment.paymentStatus)) {
                    console.log(`[APPOINTMENT PAGO] Payment ${p._id} (pending R$ ${p.amount}) → appointment ${appointmentId} paymentStatus=${appointment.paymentStatus}`);
                    if (!DRY_RUN) {
                        await Payment.findByIdAndUpdate(p._id, {
                            $set: {
                                status: 'paid',
                                paidAt: new Date(),
                                paymentDate: moment().format('YYYY-MM-DD'),
                                notes: `${p.notes || ''} [RECONCILIAÇÃO: atualizado para paid pois appointment.paymentStatus=${appointment.paymentStatus}]`.trim(),
                                updatedAt: new Date()
                            }
                        });
                    }
                    atualizados++;
                    atualizadosAppointmentPago++;
                    continue;
                }
            }

            // Estratégia 4: Verificar se existe outro Payment PAID para o mesmo paciente na mesma data
            if (patientId && p.paymentDate) {
                const paidSameDay = await Payment.findOne({
                    _id: { $ne: p._id },
                    patient: patientId,
                    paymentDate: p.paymentDate,
                    status: { $in: ['paid', 'completed', 'confirmed'] },
                    amount: { $gte: p.amount * 0.9, $lte: p.amount * 1.1 } // tolerância 10%
                }).lean();

                if (paidSameDay) {
                    console.log(`[MESMO DIA] Payment ${p._id} (pending R$ ${p.amount}) → paciente ${patientId} já pagou ${paidSameDay._id} no mesmo dia`);
                    if (!DRY_RUN) {
                        await Payment.findByIdAndUpdate(p._id, {
                            $set: {
                                status: 'canceled',
                                notes: `${p.notes || ''} [RECONCILIAÇÃO: cancelado pois paciente já possui Payment paid no mesmo dia ${paidSameDay._id}]`.trim(),
                                updatedAt: new Date()
                            }
                        });
                    }
                    cancelados++;
                    canceladosMesmoDia++;
                    continue;
                }
            }

            // Se chegou aqui, é um pending legítimo
            console.log(`[MANTIDO] Payment ${p._id}: R$ ${p.amount} — pending legítimo (session/appointment não pagos)`);
            mantidos++;

        } catch (err) {
            console.error(`[ERRO] Payment ${p._id}:`, err.message);
            erros++;
        }
    }

    console.log('\n========================================');
    console.log('[Reconciliação Particular] RESUMO');
    console.log('========================================');
    console.log(`Total analisado:        ${pendingPayments.length}`);
    console.log(`Cancelados (total):     ${cancelados}`);
    console.log(`  └─ Com paid sibling:  ${canceladosComPaidSibling}`);
    console.log(`  └─ Mesmo dia/paciente: ${canceladosMesmoDia}`);
    console.log(`Atualizados→paid:       ${atualizados}`);
    console.log(`  └─ Session paga:      ${atualizadosSessionPaga}`);
    console.log(`  └─ Appointment pago:  ${atualizadosAppointmentPago}`);
    console.log(`Mantidos (legítimos):   ${mantidos}`);
    console.log(`Erros:                  ${erros}`);
    console.log(`Modo:                   ${DRY_RUN ? 'DRY-RUN (nada foi alterado)' : 'EXECUÇÃO REAL'}`);
    console.log('========================================');

    await mongoose.disconnect();
    process.exit(0);
}

main().catch(err => {
    console.error('[Reconciliação Particular] Erro fatal:', err);
    process.exit(1);
});
