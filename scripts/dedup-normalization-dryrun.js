/**
 * ============================================================
 * DEDUP + NORMALIZATION DRY-RUN V1
 * ============================================================
 *
 * Simula a deduplicação e normalização de Payments de convênio em
 * produção, gerando cenário "antes" e "depois" sem alterar dados.
 *
 * MODO: sempre read-only (dry-run)
 *
 * Uso:
 *   node scripts/dedup-normalization-dryrun.js
 *   node scripts/dedup-normalization-dryrun.js --output=/tmp/dedup-dryrun.json
 *   node scripts/dedup-normalization-dryrun.js --db-uri="mongodb://..."
 * ============================================================
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
// ⚠️ DEVE ser importado ANTES de InsuranceGuide → identityResolver
import '../models/Patient.js';
import '../models/PatientsView.js';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import InsuranceGuide from '../models/InsuranceGuide.js';
import Convenio from '../models/Convenio.js';

dotenv.config();

const DRY_RUN = true;

function parseArgs() {
    const args = process.argv.slice(2);
    const result = { output: null, dbUri: null };
    for (const arg of args) {
        if (arg.startsWith('--output=')) {
            result.output = arg.slice(arg.indexOf('=') + 1);
        } else if (arg.startsWith('--db-uri=')) {
            result.dbUri = arg.slice(arg.indexOf('=') + 1);
        }
    }
    return result;
}

async function connect(explicitUri = null) {
    const mongoUri = explicitUri || process.env.TEST_MONGO_URI || process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!mongoUri) throw new Error('Nenhuma URI MongoDB encontrada');
    await mongoose.connect(mongoUri);
    console.log(`[DedupDryRun] MongoDB conectado: ${mongoose.connection.name}`);
}

function isEngineSource(source) {
    return source && (
        source === 'engine_v2' ||
        source.includes('engine') ||
        source.includes('insuranceBilling')
    );
}

function statusRank(status) {
    const map = {
        received: 5,
        paid: 5,
        billed: 4,
        pending_billing: 3,
        pending: 2,
        canceled: 1,
        refunded: 0
    };
    return map[status] ?? 1;
}

/**
 * Calcula score de canonicidade para escolher Payment a manter
 */
function canonicalScore(payment) {
    let score = 0;
    if (isEngineSource(payment.source)) score += 1000;
    if (payment.amount > 0 && payment.insurance?.grossAmount === payment.amount) score += 400;
    else if (payment.amount > 0) score += 200;
    score += statusRank(payment.status) * 50;
    if (payment.session) score += 30;
    if (payment.appointment) score += 20;
    if (payment.sessions && payment.sessions.length === 1) score += 10;
    if (payment.createdAt) score += new Date(payment.createdAt).getTime() / 1e10;
    return score;
}

async function resolveExpectedValue(payment) {
    const sources = [];

    // 1. Session.sessionValue
    if (payment.session) {
        const session = await Session.findById(payment.session).select('sessionValue value').lean();
        if (session?.sessionValue > 0) sources.push({ value: session.sessionValue, source: 'session.sessionValue' });
        if (session?.value > 0) sources.push({ value: session.value, source: 'session.value' });
    }

    // 2. Appointment.sessionValue / insuranceValue
    if (payment.appointment) {
        const appointment = await Appointment.findById(payment.appointment)
            .select('sessionValue insuranceValue insuranceGuide')
            .lean();
        if (appointment?.sessionValue > 0) sources.push({ value: appointment.sessionValue, source: 'appointment.sessionValue' });
        if (appointment?.insuranceValue > 0) sources.push({ value: appointment.insuranceValue, source: 'appointment.insuranceValue' });

        // 3. InsuranceGuide
        if (appointment?.insuranceGuide) {
            const guide = await InsuranceGuide.findById(appointment.insuranceGuide).select('planValue value insurance').lean();
            if (guide?.planValue > 0) sources.push({ value: guide.planValue, source: 'insuranceGuide.planValue' });
            if (guide?.value > 0) sources.push({ value: guide.value, source: 'insuranceGuide.value' });

            // 4. Convenio tabela
            if (guide?.insurance) {
                const convenio = await Convenio.findOne({ code: guide.insurance, active: true }).select('sessionValue').lean();
                if (convenio?.sessionValue > 0) sources.push({ value: convenio.sessionValue, source: `convenio(${guide.insurance}).sessionValue` });
            }
        }
    }

    // 5. Próprio Payment (fallback)
    if (payment.amount > 0) sources.push({ value: payment.amount, source: 'payment.amount' });
    if (payment.insurance?.grossAmount > 0) sources.push({ value: payment.insurance.grossAmount, source: 'payment.insurance.grossAmount' });

    // Heurística: se houver múltiplas fontes, verificar consistência
    const uniqueValues = [...new Set(sources.map(s => s.value).filter(v => v > 0))];

    return {
        sources,
        uniqueValues,
        expectedValue: uniqueValues.length === 1 ? uniqueValues[0] : (uniqueValues.length > 1 ? null : null),
        conflict: uniqueValues.length > 1
    };
}

async function analyzeDuplicates() {
    console.log('[DedupDryRun] Analisando duplicatas...');

    const pipeline = [
        { $match: { billingType: 'convenio', session: { $exists: true, $ne: null } } },
        { $group: { _id: '$session', count: { $sum: 1 }, payments: { $push: '$_id' } } },
        { $match: { count: { $gt: 1 } } }
    ];

    const groups = await Payment.collection.aggregate(pipeline).toArray();
    const operations = [];

    for (const group of groups) {
        const payments = await Payment.find({ _id: { $in: group.payments } })
            .select('_id session appointment amount insurance status source sessions createdAt')
            .lean();

        const scored = payments.map(p => ({ ...p, score: canonicalScore(p) }));
        scored.sort((a, b) => b.score - a.score);

        const keep = scored[0];
        const expected = await resolveExpectedValue(keep);

        const deleteCandidates = scored.slice(1).map(p => ({
            paymentId: p._id.toString(),
            amount: p.amount,
            grossAmount: p.insurance?.grossAmount,
            status: p.status,
            source: p.source,
            createdAt: p.createdAt,
            score: p.score,
            proposedAction: 'CANCEL'
        }));

        const normalization = analyzeValueDivergence(keep, expected);

        operations.push({
            sessionId: group._id.toString(),
            duplicateCount: group.count,
            canonicalPaymentId: keep._id.toString(),
            canonicalScore: keep.score,
            canonicalStatus: keep.status,
            canonicalAmount: keep.amount,
            canonicalGrossAmount: keep.insurance?.grossAmount,
            expectedValue: expected.expectedValue,
            expectedValueSources: expected.sources,
            valueConflict: expected.conflict,
            proposedAction: deleteCandidates.length > 0 ? 'DEDUP' : 'NONE',
            normalization,
            deleteCandidates
        });
    }

    return operations;
}

function analyzeValueDivergence(payment, expected) {
    const amount = payment.amount ?? 0;
    const grossAmount = payment.insurance?.grossAmount ?? 0;

    if (expected.conflict) {
        return { action: 'REVIEW', reason: 'fontes de valor conflitantes', expectedValue: null };
    }

    if (expected.expectedValue === null) {
        return { action: 'REVIEW', reason: 'valor esperado não determinado', expectedValue: null };
    }

    const expectedValue = expected.expectedValue;

    if (amount === expectedValue && grossAmount === expectedValue) {
        return { action: 'NONE', reason: 'valores consistentes', expectedValue: expectedValue };
    }

    if (amount === 0 && grossAmount > 0 && grossAmount === expectedValue) {
        return { action: 'UPDATE', reason: 'amount perdido, grossAmount correto', expectedValue: expectedValue };
    }

    if (amount > 0 && grossAmount === 0) {
        return { action: 'UPDATE', reason: 'grossAmount ausente', expectedValue: amount };
    }

    if (amount !== grossAmount) {
        return { action: 'REVIEW', reason: 'amount e grossAmount divergentes entre si', expectedValue: expectedValue };
    }

    return { action: 'UPDATE', reason: 'valor divergente da fonte de verdade', expectedValue: expectedValue };
}

async function analyzeAllDivergences() {
    console.log('[DedupDryRun] Analisando todas as divergências de valor...');

    const payments = await Payment.find({
        billingType: 'convenio',
        session: { $exists: true, $ne: null }
    }).select('_id session appointment amount insurance status source createdAt').lean();

    const result = [];

    for (const p of payments) {
        const expected = await resolveExpectedValue(p);
        const divergence = analyzeValueDivergence(p, expected);

        if (divergence.action !== 'NONE') {
            result.push({
                paymentId: p._id.toString(),
                sessionId: p.session?.toString?.(),
                appointmentId: p.appointment?.toString?.(),
                currentAmount: p.amount,
                currentGrossAmount: p.insurance?.grossAmount,
                status: p.status,
                source: p.source,
                expectedValue: divergence.expectedValue,
                expectedValueSources: expected.sources,
                valueConflict: expected.conflict,
                proposedAction: divergence.action,
                reason: divergence.reason
            });
        }
    }

    return result;
}

async function analyzeMissingPayments() {
    console.log('[DedupDryRun] Analisando sessions sem payment...');

    const sessions = await Session.find({
        status: 'completed',
        $or: [
            { paymentMethod: 'convenio' },
            { insuranceGuide: { $exists: true, $ne: null } }
        ]
    }).select('_id patient date sessionValue insuranceGuide paymentMethod').lean();

    const sessionIds = sessions.map(s => s._id);
    const payments = await Payment.find({
        session: { $in: sessionIds },
        billingType: 'convenio'
    }).select('session').lean();

    const sessionsWithPayment = new Set(payments.map(p => p.session.toString()));
    const missing = [];

    for (const session of sessions) {
        if (!sessionsWithPayment.has(session._id.toString())) {
            const appointment = await Appointment.findOne({ session: session._id })
                .select('_id operationalStatus billingType createdAt date')
                .lean();

            const ageDays = appointment?.createdAt
                ? Math.floor((Date.now() - new Date(appointment.createdAt)) / (1000 * 60 * 60 * 24))
                : null;

            missing.push({
                sessionId: session._id.toString(),
                patientId: session.patient?.toString?.(),
                date: session.date,
                sessionValue: session.sessionValue,
                insuranceGuide: session.insuranceGuide?.toString?.(),
                appointmentId: appointment?._id?.toString?.(),
                appointmentStatus: appointment?.operationalStatus,
                appointmentBillingType: appointment?.billingType,
                ageDays,
                proposedAction: ageDays !== null && ageDays < 7 ? 'CREATE_PAYMENT' : 'REVIEW'
            });
        }
    }

    return missing;
}

function calculateFinancialImpact(duplicateOps, divergenceOps) {
    let amountToCancel = 0;
    let amountToUpdate = 0;
    let grossAmountToUpdate = 0;

    for (const op of duplicateOps) {
        for (const del of op.deleteCandidates) {
            amountToCancel += del.amount || 0;
        }
    }

    for (const div of divergenceOps) {
        if (div.proposedAction === 'UPDATE' && div.expectedValue !== null) {
            amountToUpdate += Math.abs(div.expectedValue - (div.currentAmount || 0));
            grossAmountToUpdate += Math.abs(div.expectedValue - (div.currentGrossAmount || 0));
        }
    }

    return {
        amountToCancel,
        amountToUpdate,
        grossAmountToUpdate,
        totalFinancialAdjustment: amountToCancel + amountToUpdate
    };
}

async function main() {
    const args = parseArgs();

    console.log(`[DedupDryRun] MODO: ${DRY_RUN ? 'DRY-RUN (somente leitura)' : 'EXECUÇÃO REAL'}`);

    await connect(args.dbUri);

    const duplicateOps = await analyzeDuplicates();
    const divergenceOps = await analyzeAllDivergences();
    const missingPayments = await analyzeMissingPayments();

    const stats = {
        duplicateGroups: duplicateOps.length,
        paymentsToCancel: duplicateOps.reduce((sum, op) => sum + op.deleteCandidates.length, 0),
        paymentsToUpdate: divergenceOps.filter(d => d.proposedAction === 'UPDATE').length,
        paymentsToReview: divergenceOps.filter(d => d.proposedAction === 'REVIEW').length,
        sessionsMissingPayment: missingPayments.length,
        sessionsToCreatePayment: missingPayments.filter(m => m.proposedAction === 'CREATE_PAYMENT').length,
        sessionsToReviewMissing: missingPayments.filter(m => m.proposedAction === 'REVIEW').length
    };

    const impact = calculateFinancialImpact(duplicateOps, divergenceOps);

    const report = {
        generatedAt: new Date().toISOString(),
        database: mongoose.connection.name,
        dryRun: DRY_RUN,
        stats,
        financialImpact: impact,
        duplicateOperations: duplicateOps,
        divergenceOperations: divergenceOps,
        missingPaymentOperations: missingPayments
    };

    const outputPath = args.output || path.resolve(process.cwd(), `dedup-normalization-dryrun-${Date.now()}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));

    console.log('\n========================================');
    console.log('DEDUP + NORMALIZATION DRY-RUN RESULT');
    console.log('========================================');
    console.log(`Database: ${report.database}`);
    console.log(`Gerado em: ${report.generatedAt}`);
    console.log('---');
    console.log(`Grupos duplicados: ${stats.duplicateGroups}`);
    console.log(`Payments a cancelar: ${stats.paymentsToCancel}`);
    console.log(`Payments a atualizar valor: ${stats.paymentsToUpdate}`);
    console.log(`Payments para revisão manual: ${stats.paymentsToReview}`);
    console.log(`Sessions sem Payment: ${stats.sessionsMissingPayment}`);
    console.log(`  → Criar Payment: ${stats.sessionsToCreatePayment}`);
    console.log(`  → Revisar: ${stats.sessionsToReviewMissing}`);
    console.log('---');
    console.log(`Impacto financeiro estimado:`);
    console.log(`  Valor a cancelar: R$ ${impact.amountToCancel.toFixed(2)}`);
    console.log(`  Ajuste em amount: R$ ${impact.amountToUpdate.toFixed(2)}`);
    console.log(`  Ajuste em grossAmount: R$ ${impact.grossAmountToUpdate.toFixed(2)}`);
    console.log(`  Ajuste total bruto: R$ ${impact.totalFinancialAdjustment.toFixed(2)}`);
    console.log('========================================\n');

    console.log(`Relatório salvo em: ${outputPath}`);

    if (stats.paymentsToReview > 0 || stats.sessionsToReviewMissing > 0) {
        console.log('⚠️  Existem casos marcados para REVISÃO MANUAL antes da execução.');
    }

    await mongoose.disconnect();
    console.log('[DedupDryRun] Desconectado.');
}

main().catch(err => {
    console.error('[DedupDryRun] ERRO:', err.message);
    console.error(err.stack);
    process.exit(1);
});
