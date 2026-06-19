/**
 * ============================================================
 * STATE RECONCILIATION MAP V1
 * ============================================================
 *
 * Gera um mapa completo da corrupção estrutural atual em Payments
 * de convênio, classificando cada documento como KEEP / FIX / DELETE / REVIEW.
 *
 * MODO PADRÃO: dry-run (somente leitura, nunca altera dados)
 *
 * Uso:
 *   node scripts/state-reconciliation-map.js
 *   node scripts/state-reconciliation-map.js --output=/tmp/relatorio.json
 *   node scripts/state-reconciliation-map.js --csv=/tmp/relatorio.csv
 * ============================================================
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';

dotenv.config();

const DRY_RUN = true; // Este script NUNCA altera dados
const TIMEZONE = 'America/Sao_Paulo';

function parseArgs() {
    const args = process.argv.slice(2);
    const result = { output: null, csv: null, dbUri: null };
    for (const arg of args) {
        if (arg.startsWith('--output=')) {
            result.output = arg.slice(arg.indexOf('=') + 1);
        } else if (arg.startsWith('--csv=')) {
            result.csv = arg.slice(arg.indexOf('=') + 1);
        } else if (arg.startsWith('--db-uri=')) {
            result.dbUri = arg.slice(arg.indexOf('=') + 1);
        }
    }
    return result;
}

function toDate(v) {
    return v ? new Date(v).toISOString() : null;
}

function isEngineSource(source) {
    return source && (
        source.includes('engine') ||
        source.includes('insuranceBilling') ||
        source.includes('complete_session')
    );
}

/**
 * Score de canonicidade: maior = mais provável de ser o Payment correto
 */
function canonicalScore(payment) {
    let score = 0;
    if (isEngineSource(payment.source)) score += 100;
    if (payment.status !== 'canceled') score += 50;
    if (payment.session) score += 30;
    if (payment.appointment) score += 20;
    if (payment.sessions && payment.sessions.length === 1) score += 10;
    if (payment.insurance?.grossAmount === payment.amount) score += 10;
    if (payment.createdAt) score += new Date(payment.createdAt).getTime() / 1e10;
    return score;
}

async function connect(explicitUri = null) {
    const mongoUri = explicitUri || process.env.TEST_MONGO_URI || process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!mongoUri) throw new Error('Nenhuma URI MongoDB encontrada. Defina MONGO_URI, TEST_MONGO_URI ou use --db-uri=');
    await mongoose.connect(mongoUri);
    console.log(`[StateReconciliation] MongoDB conectado: ${mongoose.connection.name}`);
    console.log(`[StateReconciliation] URI source: ${explicitUri ? '--db-uri' : (process.env.TEST_MONGO_URI ? 'TEST_MONGO_URI' : 'MONGO_URI')}`);
}

/**
 * Encontra Payments duplicados por (session + billingType='convenio')
 */
async function findDuplicates() {
    console.log('[StateReconciliation] Buscando duplicatas por session...');

    const pipeline = [
        { $match: { billingType: 'convenio', session: { $exists: true, $ne: null }, status: { $ne: 'canceled' } } },
        { $group: { _id: '$session', count: { $sum: 1 }, payments: { $push: '$_id' } } },
        { $match: { count: { $gt: 1 } } },
        { $sort: { count: -1 } }
    ];

    const groups = await Payment.collection.aggregate(pipeline).toArray();
    const result = [];

    for (const group of groups) {
        const payments = await Payment.find({ _id: { $in: group.payments } })
            .select('_id session appointment amount insurance status source sessions createdAt')
            .sort({ createdAt: -1 })
            .lean();

        const scored = payments.map(p => ({ ...p, score: canonicalScore(p) }));
        scored.sort((a, b) => b.score - a.score);

        const keep = scored[0];
        const toDelete = scored.slice(1);

        result.push({
            sessionId: group._id.toString(),
            duplicateCount: group.count,
            keepPaymentId: keep._id.toString(),
            keepReason: 'maior canonicalScore',
            keepScore: keep.score,
            deleteCandidates: toDelete.map(p => ({
                paymentId: p._id.toString(),
                amount: p.amount,
                grossAmount: p.insurance?.grossAmount,
                status: p.status,
                source: p.source,
                createdAt: toDate(p.createdAt),
                score: p.score
            }))
        });
    }

    return result;
}

/**
 * Encontra Payments de convênio com divergência estrutural
 */
async function findDivergences() {
    console.log('[StateReconciliation] Buscando divergências estruturais...');

    const payments = await Payment.find({
        billingType: 'convenio',
        session: { $exists: true, $ne: null },
        status: { $ne: 'canceled' }
    }).select('_id session appointment amount insurance status source sessions createdAt').lean();

    const divergences = {
        grossAmountMismatch: [],
        sessionsLengthGt1: [],
        missingSessionReference: [],
        missingAppointmentReference: []
    };

    for (const p of payments) {
        if (p.insurance && p.insurance.grossAmount !== p.amount) {
            divergences.grossAmountMismatch.push({
                paymentId: p._id.toString(),
                sessionId: p.session?.toString?.(),
                amount: p.amount,
                grossAmount: p.insurance.grossAmount,
                status: p.status,
                source: p.source
            });
        }

        if (Array.isArray(p.sessions) && p.sessions.length > 1) {
            divergences.sessionsLengthGt1.push({
                paymentId: p._id.toString(),
                sessionId: p.session?.toString?.(),
                sessionsCount: p.sessions.length,
                sessions: p.sessions.map(s => s.toString()),
                status: p.status,
                source: p.source
            });
        }

        if (!p.session) {
            divergences.missingSessionReference.push({
                paymentId: p._id.toString(),
                appointmentId: p.appointment?.toString?.(),
                amount: p.amount,
                status: p.status,
                source: p.source
            });
        }

        if (!p.appointment) {
            divergences.missingAppointmentReference.push({
                paymentId: p._id.toString(),
                sessionId: p.session?.toString?.(),
                amount: p.amount,
                status: p.status,
                source: p.source
            });
        }
    }

    return divergences;
}

/**
 * Encontra Sessions completed de convênio sem Payment ou com múltiplos Payments
 */
async function findSessionPaymentGaps() {
    console.log('[StateReconciliation] Buscando gaps Session ↔ Payment...');

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
        billingType: 'convenio',
        status: { $ne: 'canceled' }
    }).select('_id session amount insurance status').lean();

    const paymentsBySession = new Map();
    for (const p of payments) {
        const sid = p.session.toString();
        if (!paymentsBySession.has(sid)) paymentsBySession.set(sid, []);
        paymentsBySession.get(sid).push(p);
    }

    const result = {
        missingPayment: [],
        multiplePayments: []
    };

    for (const session of sessions) {
        const sid = session._id.toString();
        const related = paymentsBySession.get(sid) || [];

        if (related.length === 0) {
            const appointment = await Appointment.findOne({ session: session._id })
                .select('_id operationalStatus billingType patient')
                .lean();

            result.missingPayment.push({
                sessionId: sid,
                patientId: session.patient?.toString?.(),
                date: toDate(session.date),
                sessionValue: session.sessionValue,
                insuranceGuide: session.insuranceGuide?.toString?.(),
                appointmentId: appointment?._id?.toString?.(),
                appointmentStatus: appointment?.operationalStatus,
                appointmentBillingType: appointment?.billingType
            });
        } else if (related.length > 1) {
            result.multiplePayments.push({
                sessionId: sid,
                paymentCount: related.length,
                payments: related.map(p => ({
                    paymentId: p._id.toString(),
                    amount: p.amount,
                    grossAmount: p.insurance?.grossAmount,
                    status: p.status
                }))
            });
        }
    }

    return result;
}

/**
 * Gera estatísticas gerais
 */
async function generateSummary(duplicates, divergences, gaps) {
    const totalConvenio = await Payment.countDocuments({ billingType: 'convenio' });
    const totalSessions = await Session.countDocuments({
        status: 'completed',
        $or: [
            { paymentMethod: 'convenio' },
            { insuranceGuide: { $exists: true, $ne: null } }
        ]
    });

    const totalDuplicatePayments = duplicates.reduce((sum, d) => sum + d.duplicateCount, 0);
    const affectedSessions = duplicates.length + gaps.missingPayment.length + gaps.multiplePayments.length;

    return {
        generatedAt: new Date().toISOString(),
        database: mongoose.connection.name,
        totals: {
            totalConvenioPayments: totalConvenio,
            totalCompletedConvenioSessions: totalSessions,
            duplicateGroups: duplicates.length,
            totalPaymentsInDuplicateGroups: totalDuplicatePayments,
            sessionsMissingPayment: gaps.missingPayment.length,
            sessionsWithMultiplePayments: gaps.multiplePayments.length,
            grossAmountMismatch: divergences.grossAmountMismatch.length,
            sessionsLengthGt1: divergences.sessionsLengthGt1.length,
            missingSessionReference: divergences.missingSessionReference.length,
            missingAppointmentReference: divergences.missingAppointmentReference.length
        },
        riskScore: Math.min(100, Math.round(
            (affectedSessions / Math.max(totalSessions, 1)) * 100 +
            (divergences.grossAmountMismatch.length / Math.max(totalConvenio, 1)) * 50
        ))
    };
}

function toCsv(report) {
    const rows = [];
    rows.push(['tipo', 'sessionId', 'paymentId', 'amount', 'grossAmount', 'status', 'source', 'detalhe'].join(';'));

    for (const dup of report.duplicates) {
        for (const del of dup.deleteCandidates) {
            rows.push([
                'DUPLICATE_DELETE_CANDIDATE',
                dup.sessionId,
                del.paymentId,
                del.amount,
                del.grossAmount,
                del.status,
                del.source,
                `keep=${dup.keepPaymentId}, score=${del.score}`
            ].join(';'));
        }
    }

    for (const d of report.divergences.grossAmountMismatch) {
        rows.push(['GROSS_MISMATCH', d.sessionId, d.paymentId, d.amount, d.grossAmount, d.status, d.source, ''].join(';'));
    }

    for (const d of report.divergences.sessionsLengthGt1) {
        rows.push(['AGGREGATION', d.sessionId, d.paymentId, '', '', d.status, d.source, `sessions=${d.sessionsCount}`].join(';'));
    }

    for (const d of report.divergences.missingSessionReference) {
        rows.push(['MISSING_SESSION_REF', '', d.paymentId, d.amount, '', d.status, d.source, ''].join(';'));
    }

    for (const d of report.gaps.missingPayment) {
        rows.push(['MISSING_PAYMENT', d.sessionId, '', d.sessionValue, '', '', '', `appointment=${d.appointmentId}`].join(';'));
    }

    return rows.join('\n');
}

async function main() {
    const args = parseArgs();

    console.log(`[StateReconciliation] MODO: ${DRY_RUN ? 'DRY-RUN (somente leitura)' : 'EXECUÇÃO REAL'}`);
    console.log(`[StateReconciliation] Timezone: ${TIMEZONE}`);

    await connect(args.dbUri);

    const duplicates = await findDuplicates();
    const divergences = await findDivergences();
    const gaps = await findSessionPaymentGaps();
    const summary = await generateSummary(duplicates, divergences, gaps);

    const report = {
        summary,
        duplicates,
        divergences,
        gaps
    };

    // Output JSON
    const outputPath = args.output || path.resolve(process.cwd(), `state-reconciliation-map-${Date.now()}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
    console.log(`\n[StateReconciliation] Relatório JSON salvo em: ${outputPath}`);

    // Output CSV
    if (args.csv) {
        const csvContent = toCsv(report);
        fs.writeFileSync(args.csv, csvContent);
        console.log(`[StateReconciliation] Relatório CSV salvo em: ${args.csv}`);
    }

    // Resumo no console
    console.log('\n========================================');
    console.log('RESUMO DO STATE RECONCILIATION MAP');
    console.log('========================================');
    console.log(`Database: ${summary.database}`);
    console.log(`Gerado em: ${summary.generatedAt}`);
    console.log(`Risk Score: ${summary.riskScore}/100`);
    console.log('---');
    console.log(`Total Payments convênio: ${summary.totals.totalConvenioPayments}`);
    console.log(`Total Sessions completed convênio: ${summary.totals.totalCompletedConvenioSessions}`);
    console.log(`Grupos duplicados: ${summary.totals.duplicateGroups}`);
    console.log(`Payments em grupos duplicados: ${summary.totals.totalPaymentsInDuplicateGroups}`);
    console.log(`Sessions sem Payment: ${summary.totals.sessionsMissingPayment}`);
    console.log(`Sessions com múltiplos Payments: ${summary.totals.sessionsWithMultiplePayments}`);
    console.log(`grossAmount != amount: ${summary.totals.grossAmountMismatch}`);
    console.log(`sessions.length > 1: ${summary.totals.sessionsLengthGt1}`);
    console.log(`Payments sem session: ${summary.totals.missingSessionReference}`);
    console.log(`Payments sem appointment: ${summary.totals.missingAppointmentReference}`);
    console.log('========================================\n');

    if (summary.riskScore >= 70) {
        console.log('⚠️  Risco ALTO: recomendado resolver duplicatas antes de aplicar índices únicos.');
    } else if (summary.riskScore >= 40) {
        console.log('⚠️  Risco MÉDIO: avaliar deduplicação seletiva antes do Engine reconnect.');
    } else {
        console.log('✅ Risco BAIXO: base estável para próximas fases.');
    }

    await mongoose.disconnect();
    console.log('[StateReconciliation] Desconectado.');
}

main().catch(err => {
    console.error('[StateReconciliation] ERRO:', err.message);
    console.error(err.stack);
    process.exit(1);
});
