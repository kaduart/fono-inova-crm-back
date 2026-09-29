#!/usr/bin/env node
/**
 * Reverte para 'pending' os Payments de Fono da Isis Caldas Rebelatto
 * (sessões de 24/08 e 28/08/2026), que foram marcadas como 'paid'
 * incorretamente. Objetivo: ela registrar o pagamento correto de novo pela
 * UI (aba Receber / POST /api/v2/financial/receive).
 *
 * NÃO mexe no Payment de 28/09 (6abaae5f7e9298d6a27d660e) — já está pending,
 * fica intocado por design (guarda explícita abaixo).
 *
 * Espelha a lógica de PATCH /api/v2/payments/:id/register-debit
 * (back/routes/payment.v2.js):
 *   1. FinancialLedger.debit(reversal)         — desfaz o payment_received original
 *   2. FinancialLedger.credit(payment_pending) — relança a dívida no ledger
 *   3. Payment.status: paid → pending (paidAt/financialDate: null)
 *   4. PatientBalance: +debit (idempotente por correlationId, ADR-019: só updateOne/findOneAndUpdate)
 *   5. Session/Appointment: isPaid:false, paymentStatus:'unpaid'
 *   6. Recalcula o Package 6a746daaf69cb76a5e463a38 (totalPaid/balance/financialStatus)
 *
 * Uso:
 *   node scripts/revert-isis-2408-2808.js           → dry-run (não escreve nada)
 *   node scripts/revert-isis-2408-2808.js --apply   → aplica de verdade
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '../.env') });
dotenv.config();

import '../models/index.js';
import Payment from '../models/Payment.js';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Package from '../models/Package.js';
import PatientBalance from '../models/PatientBalance.js';
import FinancialLedger from '../models/FinancialLedger.js';

const APPLY = process.argv.includes('--apply');

const PATIENT_ID = '685b0cfaaec14c7163585b5b'; // Isis Caldas Rebelatto
const PACKAGE_ID = '6a746daaf69cb76a5e463a38';
const DO_NOT_TOUCH_PAYMENT_ID = '6abaae5f7e9298d6a27d660e'; // 28/09 — pending, não mexer

const TARGETS = [
    { label: '24/08', paymentId: '6a8c91733f3e96ae214a136c' },
    { label: '28/08', paymentId: '6abab9d07e9298d6a27d6d20' }
];

// Sessões que este script vai (ou vai simular, em dry-run) reverter — usado
// pra projetar corretamente o recálculo do pacote SEM depender de --apply já
// ter sido escrito no banco. Populado só quando a reversão de fato acontece
// (ou aconteceria, se não fosse dry-run) — nunca antecipado por uma sessão
// que foi pulada por segurança/idempotência.
const revertedSessionIds = new Set();

async function main() {
    const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!mongoUri) {
        console.error('MONGODB_URI/MONGO_URI não encontrado');
        process.exit(1);
    }

    // Guarda de segurança: nunca deixa mexer no payment de 28/09 por engano
    if (TARGETS.some(t => t.paymentId === DO_NOT_TOUCH_PAYMENT_ID)) {
        throw new Error('DO_NOT_TOUCH_PAYMENT_ID está na lista de TARGETS — abortando antes de conectar');
    }

    await mongoose.connect(mongoUri);
    console.log(`Conectado. Modo: ${APPLY ? '⚠️  APPLY (vai escrever)' : '🔍 DRY-RUN (nada será escrito)'}\n`);

    for (const target of TARGETS) {
        console.log(`\n=== ${target.label} — payment ${target.paymentId} ===`);
        const payment = await Payment.findById(target.paymentId);
        if (!payment) {
            console.log('  ❌ Payment não encontrado, pulando.');
            continue;
        }
        console.log(`  status atual: ${payment.status} | amount: ${payment.amount} | method: ${payment.paymentMethod} | patient: ${payment.patient} | appointment: ${payment.appointment} | session: ${payment.session}`);

        if (payment.patient?.toString() !== PATIENT_ID) {
            console.log(`  ⚠️  Payment não pertence à Isis (patient=${payment.patient}). Pulando por segurança.`);
            continue;
        }
        if (payment.billingType !== 'particular') {
            console.log(`  ⚠️  billingType=${payment.billingType} (esperado 'particular'). Pulando por segurança.`);
            continue;
        }
        if (payment.status !== 'paid') {
            console.log(`  ℹ️  Já está '${payment.status}' (não é 'paid'). Nada a fazer.`);
            continue;
        }

        const correlationId = `manual_debit_revert_isis_${target.paymentId}`;
        const reversalCorrelationId = `${correlationId}_reversal`;

        // Idempotência: se já existe o ledger de reversão pra esse payment, não duplica.
        const alreadyReverted = await FinancialLedger.findOne({
            payment: payment._id,
            type: 'reversal',
            correlationId: reversalCorrelationId
        }).lean();
        if (alreadyReverted) {
            console.log('  ℹ️  Já revertido anteriormente (ledger encontrado). Pulando.');
            continue;
        }

        console.log('  → vai reverter: status paid→pending, paidAt/financialDate→null');
        console.log(`  → vai marcar Session ${payment.session || '(nenhuma)'} e Appointment ${payment.appointment || '(nenhum)'} como não-pagos`);
        console.log(`  → vai lançar débito de R$${payment.amount} na PatientBalance da Isis`);

        // Marca a sessão como "será revertida" ANTES do gate de --apply, pra
        // que o recálculo projetado do pacote (mais abaixo) já reflita esta
        // reversão mesmo em dry-run. Em modo --apply, se a transação abaixo
        // falhar, desfaz essa marcação (senão o recálculo do pacote ficaria
        // otimista demais, contando uma reversão que não aconteceu de fato).
        if (payment.session) revertedSessionIds.add(payment.session.toString());

        if (!APPLY) continue;

        const mongoSession = await mongoose.startSession();
        await mongoSession.startTransaction();
        try {
            const now = new Date();

            await FinancialLedger.debit({
                type: 'reversal',
                amount: payment.amount,
                billingType: 'particular',
                patient: payment.patient,
                appointment: payment.appointment,
                session: payment.session,
                payment: payment._id,
                correlationId: reversalCorrelationId,
                description: `Reversão manual (script): sessão de ${target.label} marcada como paga incorretamente, convertida de volta para pendente`,
                occurredAt: now,
                createdBy: null,
                metadata: { source: 'script_revert_isis_2408_2808', reason: 'wrong_settlement' }
            }, mongoSession);

            await FinancialLedger.credit({
                type: 'payment_pending',
                amount: payment.amount,
                billingType: 'particular',
                patient: payment.patient,
                appointment: payment.appointment,
                session: payment.session,
                payment: payment._id,
                correlationId,
                description: `Sessão de ${target.label} revertida para pendente (script) — Isis vai registrar o pagamento correto pela UI`,
                occurredAt: now,
                createdBy: null,
                metadata: { source: 'script_revert_isis_2408_2808', reason: 'wrong_settlement' }
            }, mongoSession);

            await Payment.findByIdAndUpdate(
                payment._id,
                { $set: { status: 'pending', paidAt: null, financialDate: null } },
                { session: mongoSession }
            );

            await PatientBalance.findOneAndUpdate(
                { patient: payment.patient },
                {
                    $push: {
                        transactions: {
                            type: 'debit',
                            amount: payment.amount,
                            description: `Sessão de ${target.label} revertida para pendente (script) — cobrança incorreta desfeita`,
                            sessionId: payment.session || null,
                            appointmentId: payment.appointment || null,
                            correlationId,
                            registeredBy: null,
                            transactionDate: now
                        }
                    },
                    $inc: { currentBalance: payment.amount, totalDebited: payment.amount },
                    $setOnInsert: { patient: payment.patient, createdAt: now },
                    $set: { lastTransactionAt: now }
                },
                { session: mongoSession, upsert: true, new: true }
            );

            if (payment.session) {
                await Session.findByIdAndUpdate(
                    payment.session,
                    { $set: { isPaid: false, paymentStatus: 'unpaid', paymentOrigin: 'manual_balance' } },
                    { session: mongoSession, new: true }
                );
            }
            if (payment.appointment) {
                await Appointment.findByIdAndUpdate(
                    payment.appointment,
                    { $set: { isPaid: false, paymentStatus: 'unpaid' } },
                    { session: mongoSession }
                );
            }

            await mongoSession.commitTransaction();
            console.log('  ✅ Revertido com sucesso.');
        } catch (err) {
            await mongoSession.abortTransaction();
            // Reversão não aconteceu de fato — remove a marcação otimista pra
            // não distorcer o recálculo do pacote logo abaixo.
            if (payment.session) revertedSessionIds.delete(payment.session.toString());
            console.error(`  ❌ Erro ao reverter ${target.label}:`, err.message);
        } finally {
            mongoSession.endSession();
        }
    }

    // Recalcula o pacote a partir das sessions isPaid:true restantes (mesma
    // fórmula do bulk-settle/receive: consumedValue = paidCount * sessionValue).
    console.log(`\n=== Recalculando pacote ${PACKAGE_ID} ===`);
    const pkg = await Package.findById(PACKAGE_ID);
    if (pkg) {
        const currentPaidCount = await Session.countDocuments({ package: pkg._id, isPaid: true });
        // Em --apply as sessões revertidas já saíram do countDocuments acima
        // (foram persistidas como isPaid:false antes de chegar aqui). Em
        // dry-run elas ainda contam, então subtraímos a marcação otimista pra
        // projetar o resultado real sem escrever nada.
        const stillCountedReverted = APPLY ? 0 : revertedSessionIds.size;
        const paidCount = currentPaidCount - stillCountedReverted;
        const consumedValue = paidCount * (pkg.sessionValue || 0);
        const totalPaid = consumedValue;
        const balance = Math.max(0, (pkg.totalValue || 0) - totalPaid);
        let financialStatus = 'unpaid';
        if (balance <= 0 && totalPaid > 0) financialStatus = 'paid';
        else if (totalPaid > 0) financialStatus = 'partially_paid';

        console.log(`  paidCount=${paidCount} | consumedValue=${consumedValue}`);
        console.log(`  totalPaid: ${pkg.totalPaid} → ${totalPaid} | balance: ${pkg.balance} → ${balance} | financialStatus: ${pkg.financialStatus} → ${financialStatus}`);

        if (APPLY) {
            await Package.updateOne(
                { _id: pkg._id },
                { $set: { totalPaid, consumedValue, balance, financialStatus, updatedAt: new Date() } }
            );
            console.log('  ✅ Pacote recalculado.');
        }
    } else {
        console.log('  ❌ Pacote não encontrado.');
    }

    console.log(`\n${APPLY ? '✅ Concluído (dados alterados).' : '🔍 Dry-run concluído. Rode com --apply para aplicar de verdade.'}`);
    process.exit(0);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
