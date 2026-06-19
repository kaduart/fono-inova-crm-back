/**
 * ============================================================
 * BACKFILL PAYMENT KIND v1
 * ============================================================
 *
 * Enriquece payments com kind=null de forma auditável e reversível.
 *
 * Regras determinísticas (ordem de prioridade):
 *   1. amount < 0  → manual_adjustment
 *   2. package     → package_payment
 *   3. session || appointment  → session_payment
 *   4. !patient    → unknown_or_orphan
 *   5. fallback    → session_payment (com base no dataset)
 *
 * Características de segurança:
 *   - dry-run por padrão
 *   - snapshot em PaymentKindAudit antes de mutar
 *   - confidence flag (high/medium/low)
 *   - rollback via --rollback=<executionId>
 *
 * Uso:
 *   node scripts/backfill-payment-kind.js              # dry-run
 *   node scripts/backfill-payment-kind.js --execute    # execução real
 *   node scripts/backfill-payment-kind.js --rollback=<executionId>
 * ============================================================
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

import '../models/Patient.js';
import '../models/PatientsView.js';
import Payment from '../models/Payment.js';
import { resolvePaymentKind } from '../utils/resolvePaymentKind.js';

const BATCH_SIZE = 50;
const AUDIT_COLLECTION = 'PaymentKindAudit';

function parseArgs() {
    const args = process.argv.slice(2);
    const result = { execute: false, rollback: null, dbUri: null };
    for (const arg of args) {
        if (arg === '--execute') {
            result.execute = true;
        } else if (arg.startsWith('--rollback=')) {
            result.rollback = arg.slice(arg.indexOf('=') + 1);
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
    console.log(`[BackfillKind] MongoDB conectado: ${mongoose.connection.name}`);
}

function classify(payment) {
    return resolvePaymentKind(payment);
}

async function findCandidates() {
    return Payment.find({
        $or: [
            { kind: null },
            { kind: { $exists: false } }
        ]
    }).sort({ createdAt: 1 }).lean();
}

async function createSnapshot(executionId, operations) {
    const auditCollection = mongoose.connection.db.collection(AUDIT_COLLECTION);
    const docs = operations.map(op => ({
        executionId,
        operationId: `${executionId}_${op.paymentId}`,
        paymentId: op.paymentId,
        operation: 'UPDATE_KIND',
        before: { kind: op.previousKind },
        after: {
            kind: op.newKind,
            kindConfidence: op.confidence,
            kindSource: 'backfill_v1'
        },
        reason: op.reason,
        confidence: op.confidence,
        createdAt: new Date()
    }));

    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
        await auditCollection.insertMany(docs.slice(i, i + BATCH_SIZE));
    }
    console.log(`[BackfillKind] Snapshot criado: ${executionId} (${docs.length} operações)`);
}

async function dryRun() {
    const candidates = await findCandidates();
    const operations = [];
    const summary = {};

    for (const p of candidates) {
        const { kind, confidence, reason } = classify(p);
        operations.push({
            paymentId: p._id.toString(),
            previousKind: p.kind,
            newKind: kind,
            confidence,
            reason,
            amount: p.amount,
            status: p.status
        });
        summary[kind] = summary[kind] || { count: 0, total: 0 };
        summary[kind].count++;
        summary[kind].total += p.amount || 0;
    }

    console.log('\n========================================');
    console.log('BACKFILL PAYMENT KIND — PLANO');
    console.log('========================================');
    console.log(`Modo: DRY-RUN`);
    console.log(`Database: ${mongoose.connection.name}`);
    console.log(`Operações planejadas: ${operations.length}`);
    console.log('\nClassificação proposta:');
    for (const [kind, data] of Object.entries(summary).sort((a, b) => b[1].count - a[1].count)) {
        console.log(`  ${kind.padEnd(20)} | ${String(data.count).padStart(4)} | R$${data.total.toFixed(2)}`);
    }
    console.log('========================================\n');

    return operations;
}

async function execute() {
    const candidates = await findCandidates();
    if (candidates.length === 0) {
        console.log('[BackfillKind] Nenhum candidato encontrado.');
        return;
    }

    const operations = candidates.map(p => {
        const { kind, confidence, reason } = classify(p);
        return {
            paymentId: p._id.toString(),
            previousKind: p.kind,
            newKind: kind,
            confidence,
            reason,
            amount: p.amount,
            status: p.status
        };
    });

    const executionId = `kindfill-${Date.now()}`;

    console.log('\n========================================');
    console.log('BACKFILL PAYMENT KIND — EXECUÇÃO REAL');
    console.log('========================================');
    console.log(`Execution ID: ${executionId}`);
    console.log(`Operações: ${operations.length}`);
    console.log('========================================\n');

    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            await createSnapshot(executionId, operations);

            for (let i = 0; i < operations.length; i += BATCH_SIZE) {
                const batch = operations.slice(i, i + BATCH_SIZE);
                const bulkOps = batch.map(op => ({
                    updateOne: {
                        filter: { _id: new mongoose.Types.ObjectId(op.paymentId) },
                        update: {
                            $set: {
                                kind: op.newKind,
                                kindConfidence: op.confidence,
                                kindSource: 'backfill_v1'
                            }
                        }
                    }
                }));
                await Payment.collection.bulkWrite(bulkOps, { session });
                console.log(`[BackfillKind] Executando batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(operations.length / BATCH_SIZE)}`);
            }
        });

        console.log('[BackfillKind] ✅ Transação commitada com sucesso');
        console.log('\n========================================');
        console.log('EXECUÇÃO CONCLUÍDA');
        console.log('========================================');
        console.log(`Execution ID: ${executionId}`);
        console.log(`Payments atualizados: ${operations.length}`);
        console.log(`Snapshot: ${AUDIT_COLLECTION}`);
        console.log(`Rollback: node scripts/backfill-payment-kind.js --rollback=${executionId}`);
        console.log('========================================\n');
    } catch (err) {
        console.error('[BackfillKind] ❌ Erro durante execução:', err.message);
        throw err;
    } finally {
        await session.endSession();
    }
}

async function rollback(executionId) {
    const auditCollection = mongoose.connection.db.collection(AUDIT_COLLECTION);
    const records = await auditCollection.find({ executionId }).toArray();

    if (records.length === 0) {
        console.log(`[BackfillKind] Nenhum snapshot encontrado para ${executionId}`);
        return;
    }

    console.log(`[BackfillKind] Iniciando rollback da execução ${executionId}`);

    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            for (let i = 0; i < records.length; i += BATCH_SIZE) {
                const batch = records.slice(i, i + BATCH_SIZE);
                const bulkOps = batch.map(r => ({
                    updateOne: {
                        filter: { _id: new mongoose.Types.ObjectId(r.paymentId) },
                        update: {
                            $set: { kind: r.before.kind },
                            $unset: { kindConfidence: 1, kindSource: 1 }
                        }
                    }
                }));
                await Payment.collection.bulkWrite(bulkOps, { session });
            }
        });
        console.log(`[BackfillKind] ✅ Rollback de ${executionId} concluído (${records.length} operações)`);
    } catch (err) {
        console.error('[BackfillKind] ❌ Erro durante rollback:', err.message);
        throw err;
    } finally {
        await session.endSession();
    }
}

async function main() {
    const args = parseArgs();
    await connect(args.dbUri);

    try {
        if (args.rollback) {
            await rollback(args.rollback);
        } else if (args.execute) {
            await execute();
        } else {
            await dryRun();
        }
    } finally {
        await mongoose.disconnect();
        console.log('[BackfillKind] Desconectado.');
    }
}

main().catch(err => {
    console.error('[BackfillKind] FATAL:', err);
    process.exit(1);
});
