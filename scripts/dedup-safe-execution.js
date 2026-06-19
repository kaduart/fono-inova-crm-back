/**
 * ============================================================
 * DEDUP SAFE EXECUTION V1
 * ============================================================
 *
 * Executa apenas a FASE 1 segura da deduplicação:
 *   - cancela Payments duplicados de convênio (não canônicos)
 *   - NÃO altera valores (amount / grossAmount)
 *   - NÃO cria Payments novos
 *   - NÃO normaliza divergências
 *
 * Características de segurança:
 *   - dry-run por padrão
 *   - snapshot completo antes da operação
 *   - execução em batches
 *   - rollback automático em caso de erro
 *   - audit trail completo
 *
 * Uso:
 *   node scripts/dedup-safe-execution.js                          # dry-run
 *   node scripts/dedup-safe-execution.js --execute                # execução real
 *   node scripts/dedup-safe-execution.js --rollback=<executionId> # reversão
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

dotenv.config();

const BATCH_SIZE = 5;
const AUDIT_COLLECTION = 'PaymentDedupAudit';

function parseArgs() {
    const args = process.argv.slice(2);
    const result = { execute: false, rollback: null, dbUri: null, output: null };
    for (const arg of args) {
        if (arg === '--execute') {
            result.execute = true;
        } else if (arg.startsWith('--rollback=')) {
            result.rollback = arg.slice(arg.indexOf('=') + 1);
        } else if (arg.startsWith('--db-uri=')) {
            result.dbUri = arg.slice(arg.indexOf('=') + 1);
        } else if (arg.startsWith('--output=')) {
            result.output = arg.slice(arg.indexOf('=') + 1);
        }
    }
    return result;
}

async function connect(explicitUri = null) {
    const mongoUri = explicitUri || process.env.TEST_MONGO_URI || process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!mongoUri) throw new Error('Nenhuma URI MongoDB encontrada');
    await mongoose.connect(mongoUri);
    console.log(`[DedupSafeExec] MongoDB conectado: ${mongoose.connection.name}`);
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

async function buildOperations() {
    console.log('[DedupSafeExec] Identificando duplicatas...');

    const pipeline = [
        { $match: { billingType: 'convenio', session: { $exists: true, $ne: null } } },
        { $group: { _id: '$session', count: { $sum: 1 }, payments: { $push: '$_id' } } },
        { $match: { count: { $gt: 1 } } }
    ];

    const groups = await Payment.collection.aggregate(pipeline).toArray();
    const operations = [];

    for (const group of groups) {
        const payments = await Payment.find({ _id: { $in: group.payments } }).lean();
        const scored = payments.map(p => ({ ...p, score: canonicalScore(p) }));
        scored.sort((a, b) => b.score - a.score);

        const keep = scored[0];

        for (const candidate of scored.slice(1)) {
            operations.push({
                type: 'CANCEL_DUPLICATE',
                sessionId: group._id.toString(),
                canonicalPaymentId: keep._id.toString(),
                targetPaymentId: candidate._id.toString(),
                targetBefore: candidate,
                reason: 'Payment duplicado para mesma session/billingType. Canônico escolhido por maior score.',
                proposedAfter: {
                    status: 'canceled',
                    canceledReason: 'dedup_safe_execution_v1',
                    canceledAt: new Date().toISOString(),
                    canceledMetadata: {
                        dedupGroupId: group._id.toString(),
                        replacedBy: keep._id.toString(),
                        reason: 'duplicate_payment_cleanup'
                    }
                }
            });
        }
    }

    return operations;
}

async function createAuditSnapshot(executionId, operations, mongoSession) {
    const auditCol = mongoose.connection.collection(AUDIT_COLLECTION);
    const auditDoc = {
        executionId,
        operationType: 'DEDUP_STRUCTURE',
        executedAt: new Date(),
        status: 'prepared',
        database: mongoose.connection.name,
        totalOperations: operations.length,
        operations: operations.map(op => ({
            operationId: `${executionId}_${op.targetPaymentId}`,
            type: op.type,
            sessionId: op.sessionId,
            canonicalPaymentId: op.canonicalPaymentId,
            targetPaymentId: op.targetPaymentId,
            before: op.targetBefore,
            after: op.proposedAfter,
            reason: op.reason,
            rolledBack: false
        }))
    };

    await auditCol.insertOne(auditDoc, { session: mongoSession });
    console.log(`[DedupSafeExec] Snapshot criado: ${executionId} (${operations.length} operações)`);
    return auditDoc;
}

async function executeOperations(operations, executionId) {
    const mongoSession = await mongoose.startSession();
    await mongoSession.startTransaction();

    const auditCol = mongoose.connection.collection(AUDIT_COLLECTION);
    const results = [];

    try {
        await createAuditSnapshot(executionId, operations, mongoSession);

        for (let i = 0; i < operations.length; i += BATCH_SIZE) {
            const batch = operations.slice(i, i + BATCH_SIZE);
            console.log(`[DedupSafeExec] Executando batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(operations.length / BATCH_SIZE)}`);

            for (const op of batch) {
                const before = await Payment.findById(op.targetPaymentId).session(mongoSession).lean();
                if (!before) {
                    throw new Error(`Payment ${op.targetPaymentId} não encontrado durante execução`);
                }

                const update = await Payment.findByIdAndUpdate(
                    op.targetPaymentId,
                    {
                        $set: {
                            status: 'canceled',
                            canceledReason: 'dedup_safe_execution_v1',
                            canceledAt: new Date(),
                            canceledMetadata: {
                                dedupGroupId: op.sessionId,
                                replacedBy: op.canonicalPaymentId,
                                executionId: executionId,
                                reason: 'duplicate_payment_cleanup'
                            }
                        }
                    },
                    { session: mongoSession, new: true }
                );

                await auditCol.updateOne(
                    { 'operations.operationId': `${executionId}_${op.targetPaymentId}` },
                    {
                        $set: {
                            'operations.$.appliedAt': new Date(),
                            'operations.$.after.status': update.status,
                            'operations.$.after.canceledReason': update.canceledReason,
                            'operations.$.after.canceledAt': update.canceledAt,
                            'operations.$.after.canceledMetadata': update.canceledMetadata
                        }
                    },
                    { session: mongoSession }
                );

                results.push({
                    operationId: `${executionId}_${op.targetPaymentId}`,
                    status: 'applied',
                    paymentId: op.targetPaymentId,
                    previousStatus: before.status,
                    newStatus: update.status
                });
            }
        }

        await auditCol.updateOne(
            { executionId },
            { $set: { status: 'executed', executedAt: new Date() } },
            { session: mongoSession }
        );

        await mongoSession.commitTransaction();
        console.log('[DedupSafeExec] ✅ Transação commitada com sucesso');
        return results;

    } catch (error) {
        console.error('[DedupSafeExec] ❌ Erro durante execução — iniciando rollback automático');
        await mongoSession.abortTransaction();
        throw error;
    } finally {
        mongoSession.endSession();
    }
}

async function rollbackExecution(executionId) {
    const auditCol = mongoose.connection.collection(AUDIT_COLLECTION);
    const audit = await auditCol.findOne({ executionId });

    if (!audit) {
        throw new Error(`Execução ${executionId} não encontrada para rollback`);
    }

    if (audit.status === 'rolled_back') {
        console.log(`[DedupSafeExec] Execução ${executionId} já foi revertida anteriormente`);
        return [];
    }

    const mongoSession = await mongoose.startSession();
    await mongoSession.startTransaction();

    const results = [];

    try {
        for (const op of audit.operations) {
            const before = op.before;

            await Payment.findByIdAndUpdate(
                op.targetPaymentId,
                {
                    $set: {
                        status: before.status,
                        canceledReason: before.canceledReason || null,
                        canceledAt: before.canceledAt || null
                    }
                },
                { session: mongoSession }
            );

            await auditCol.updateOne(
                { 'operations.operationId': op.operationId },
                { $set: { 'operations.$.rolledBack': true, 'operations.$.rolledBackAt': new Date() } },
                { session: mongoSession }
            );

            results.push({
                operationId: op.operationId,
                paymentId: op.targetPaymentId,
                restoredStatus: before.status
            });
        }

        await auditCol.updateOne(
            { executionId },
            { $set: { status: 'rolled_back', rolledBackAt: new Date() } },
            { session: mongoSession }
        );

        await mongoSession.commitTransaction();
        console.log(`[DedupSafeExec] ✅ Rollback de ${executionId} concluído (${results.length} operações)`);
        return results;

    } catch (error) {
        await mongoSession.abortTransaction();
        throw error;
    } finally {
        mongoSession.endSession();
    }
}

async function main() {
    const args = parseArgs();

    await connect(args.dbUri);

    // ROLLBACK
    if (args.rollback) {
        console.log(`[DedupSafeExec] Iniciando rollback da execução ${args.rollback}`);
        const results = await rollbackExecution(args.rollback);

        const report = {
            type: 'ROLLBACK',
            executionId: args.rollback,
            rolledBackAt: new Date().toISOString(),
            restoredOperations: results.length,
            details: results
        };

        const outputPath = args.output || path.resolve(process.cwd(), `dedup-rollback-${args.rollback}.json`);
        fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
        console.log(`[DedupSafeExec] Relatório de rollback salvo em: ${outputPath}`);

        await mongoose.disconnect();
        return;
    }

    // DRY-RUN OU EXECUÇÃO
    const operations = await buildOperations();

    if (operations.length === 0) {
        console.log('[DedupSafeExec] Nenhuma duplicata encontrada. Nada a fazer.');
        await mongoose.disconnect();
        return;
    }

    console.log(`\n========================================`);
    console.log(`DEDUP SAFE EXECUTION — PLANO`);
    console.log(`========================================`);
    console.log(`Modo: ${args.execute ? 'EXECUÇÃO REAL' : 'DRY-RUN'}`);
    console.log(`Database: ${mongoose.connection.name}`);
    console.log(`Operações planejadas: ${operations.length}`);
    console.log(`Todas as operações são: CANCEL de Payment duplicado`);
    console.log(`NENHUM valor será alterado`);
    console.log(`========================================\n`);

    if (!args.execute) {
        const report = {
            type: 'DRY-RUN',
            generatedAt: new Date().toISOString(),
            database: mongoose.connection.name,
            totalOperations: operations.length,
            operations
        };

        const outputPath = args.output || path.resolve(process.cwd(), `dedup-safe-execution-dryrun-${Date.now()}.json`);
        fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
        console.log(`[DedupSafeExec] Dry-run salvo em: ${outputPath}`);
        console.log('[DedupSafeExec] Adicione --execute para executar de verdade.');

        await mongoose.disconnect();
        return;
    }

    // EXECUÇÃO REAL
    const executionId = `dedup-${Date.now()}`;
    console.log(`[DedupSafeExec] Iniciando execução real: ${executionId}`);

    const results = await executeOperations(operations, executionId);

    const report = {
        type: 'EXECUTION',
        executionId,
        executedAt: new Date().toISOString(),
        database: mongoose.connection.name,
        totalOperations: operations.length,
        appliedOperations: results.length,
        rollbackCommand: `node scripts/dedup-safe-execution.js --rollback=${executionId}`,
        operations: results
    };

    const outputPath = args.output || path.resolve(process.cwd(), `dedup-safe-execution-${executionId}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));

    console.log('\n========================================');
    console.log('EXECUÇÃO CONCLUÍDA');
    console.log('========================================');
    console.log(`Execution ID: ${executionId}`);
    console.log(`Payments cancelados: ${results.length}`);
    console.log(`Snapshot salvo em: ${AUDIT_COLLECTION}`);
    console.log(`Rollback: node scripts/dedup-safe-execution.js --rollback=${executionId}`);
    console.log(`Relatório: ${outputPath}`);
    console.log('========================================\n');

    await mongoose.disconnect();
}

main().catch(err => {
    console.error('[DedupSafeExec] ERRO:', err.message);
    console.error(err.stack);
    process.exit(1);
});
