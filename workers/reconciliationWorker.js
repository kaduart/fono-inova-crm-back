// workers/reconciliationWorker.js
/**
 * 🔍 RECONCILIATION WORKER - Auto-Healing Financeiro
 * 
 * Responsabilidade: Garantir consistência entre todos os domínios financeiros
 * 
 * Verifica:
 * - Payment ↔ Ledger (caixa deve bater)
 * - Payment ↔ FinancialProjection (dashboard deve refletir)
 * - Payment ↔ PatientBalance (créditos/débitos corretos)
 * 
 * Frequência: A cada 5 minutos + após eventos suspeitos
 */

import { Worker } from 'bullmq';
import { redisConnection } from '../infrastructure/queue/queueConfig.js';
import Payment from '../models/Payment.js';
import FinancialLedger from '../models/FinancialLedger.js';
import FinancialProjection from '../models/FinancialProjection.js';
import PatientBalance from '../models/PatientBalance.js';
import mongoose from 'mongoose';
import { logMetric } from '../utils/logMetric.js';

const RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutos

export function startReconciliationWorker() {
    const worker = new Worker('financial-reconciliation', async (job) => {
        const { checkType = 'full', month, correlationId = `recon_${Date.now()}` } = job.data;
        
        console.log(`[ReconciliationWorker] Iniciando verificação: ${checkType}`, { correlationId });
        
        const results = {
            checked: 0,
            inconsistencies: 0,
            autoFixed: 0,
            manualReview: [],
            timestamp: new Date()
        };
        
        try {
            switch (checkType) {
                case 'payment-ledger':
                    await reconcilePaymentNetCredit(results);
                    await reconcileOrphanLedgerEntries(results);
                    await reportMonthlyLedgerNetMovement(results, month);
                    break;
                case 'payment-projection':
                    await reconcilePaymentProjection(results, month);
                    break;
                case 'full':
                default:
                    await reconcilePaymentNetCredit(results);
                    await reconcileOrphanLedgerEntries(results);
                    await reportMonthlyLedgerNetMovement(results, month);
                    await reconcilePaymentProjection(results, month);
                    await reconcilePatientBalance(results);
            }
            
            // Log resultado
            console.log(`[ReconciliationWorker] Concluído:`, {
                checked: results.checked,
                inconsistencies: results.inconsistencies,
                autoFixed: results.autoFixed
            });
            
            // Se tem inconsistências graves, apenas loga alerta
            if (results.manualReview.length > 0) {
                console.warn(`[ReconciliationWorker] ⚠️ ${results.manualReview.length} inconsistências requerem revisão manual`, {
                    severity: results.manualReview.length > 5 ? 'high' : 'medium',
                    issues: results.manualReview,
                    summary: {
                        checked: results.checked,
                        inconsistencies: results.inconsistencies,
                        autoFixed: results.autoFixed
                    }
                });
            }
            
            return results;
            
        } catch (error) {
            console.error('[ReconciliationWorker] Erro:', error);
            throw error;
        }
    }, {
        connection: redisConnection,
        concurrency: 1 // Só um job por vez
    });
    
    console.log('[ReconciliationWorker] Worker iniciado');
    
    // Agenda verificação periódica
    setInterval(async () => {
        const queue = worker.queue || (await import('../infrastructure/queue/queueConfig.js')).getQueue('financial-reconciliation');
        await queue.add('periodic-check', { checkType: 'full' }, {
            jobId: `recon-${Date.now()}`,
            removeOnComplete: 10
        });
    }, RECONCILIATION_INTERVAL_MS);
    
    return worker;
}

// Tipos de lançamento que representam movimento de CAIXA real (entrada ou
// saída de dinheiro de verdade). Deliberadamente excluídos: 'payment_pending'
// (conta a receber, direction='credit' mas não é dinheiro na mão — fiado),
// 'insurance_billed' (conta a receber de convênio), 'package_consumed'/
// 'revenue_recognition'/'adjustment'/'transfer' (reconhecimento contábil, não
// caixa). 'reversal'/'refund'/'write_off' SÓ contam quando vinculados
// (`payment`) a um desses tipos de caixa — usamos `direction` pra achar o
// sinal, nunca presumindo que o nome do tipo já garante o sinal certo.
const CASH_LEDGER_TYPES = Object.freeze(['payment_received', 'package_purchase', 'insurance_received']);
const CASH_ADJUSTMENT_TYPES = Object.freeze(['reversal', 'refund', 'write_off']);

// 📅 Corte empírico de adoção do ledger: o primeiro lançamento
// `payment_received` de toda a coleção foi criado em 2026-04-11
// (occurredAt=2026-04-01) — confirmado por query direta no banco real
// (2026-08-26). Payments 'paid' criados ANTES disso não têm — e nunca
// tiveram — cobertura de ledger por definição (o mecanismo não existia
// ainda), então "crédito líquido = 0" para eles não é uma inconsistência,
// é esperado. Amostragem real por mês confirmou o corte: 100% de mismatch
// em todo mês anterior a 2026-04, proporção crescente de "OK" a partir daí.
// Tratar como categoria separada evita o falso "447 pagamentos com dinheiro
// faltando" que uma checagem sem esse corte gera.
const LEDGER_ADOPTION_CUTOFF = new Date('2026-04-01T00:00:00Z');

/**
 * 🔍 [Verificação 1] Consistência Payment ↔ Ledger POR PAYMENT INDIVIDUAL
 *
 * Regra (não mais "soma do mês bate soma do mês" — ver motivo no redesenho
 * abaixo): cada Payment tem um crédito líquido esperado, calculado só a
 * partir do PRÓPRIO ledger dele (créditos de tipo de caixa menos reversões
 * que os compensam):
 *   - status='paid'          → crédito líquido deve ser exatamente o amount.
 *   - status in [pending,
 *     canceled, refunded]    → crédito líquido deve ser exatamente zero.
 *
 * Por que por-Payment e não por mês: o ledger é imutável e sobrevive à
 * exclusão de Payment/Package/Patient (docs/DELETE_CASCADE_CONTRACT.md), e
 * uma reversão pode acontecer em mês diferente do crédito original — somar
 * "tudo que aconteceu neste mês" e comparar contra "payments que existem
 * hoje" mistura dois relógios diferentes e gera falso positivo permanente
 * (achado real 2026-08-26: PATCH genérico revertendo status sem ledger
 * inflava esse comparativo mensal pra sempre). Por-Payment não tem esse
 * problema: a pergunta "este Payment específico está certo?" não depende de
 * em qual mês as coisas aconteceram.
 *
 * Quatro modelos financeiros (utils/packageFinancialModel.js +
 * docs/finance-integrity-audit/classification-rules.md — não reinventado
 * aqui, só aplicado):
 *   - PREPAID (particular pré-pago): consumo (isFromPackage=true ou
 *     kind='package_consumed') NUNCA espera crédito — excluído do universo.
 *   - PER_SESSION (particular por sessão): espera payment_received.
 *   - JUDICIAL_LIMINAR: validado empiricamente contra dado real (30/30
 *     Payments 'paid' billingType=liminar batem certo) — o caminho ativo
 *     (completeSessionService.v2.js, não o recognizeRevenue.js desativado)
 *     já credita normalmente via recordPaymentReceived, mesmo mecanismo do
 *     particular per-session. Sem exclusão especial necessária.
 *   - CONVENIO: espera insurance_received (já incluído em
 *     CASH_LEDGER_TYPES) — só Payments com status='paid' (passaram por
 *     /receive) entram no universo; 'billed' (aguardando NF) fica de fora
 *     por construção do filtro de status.
 */
async function reconcilePaymentNetCredit(results, { limit = 500 } = {}) {
    const { recordPaymentReceived } = await import('../services/financialLedgerService.js');
    const { isPackageConsumptionPayment } = await import('../utils/packageConsumptionPayment.js');

    const rawCandidates = await Payment.find({
        status: { $in: ['paid', 'pending', 'canceled', 'refunded'] },
        kind: { $ne: 'package_consumed' } // 🛡️ package_consumed nunca é caixa
    }).select('_id amount status patient appointment session paymentMethod paidAt paymentDate createdAt isFromPackage kind billingType').sort({ updatedAt: -1 }).limit(limit).lean();

    // Modelo PREPAID: consumo de pacote pré-pago nunca espera crédito, mesmo
    // quando não usa kind='package_consumed' literalmente (edge case
    // isPrepaidFallback em particularHandler.js usa kind='session_payment' +
    // isFromPackage=true) — utils/packageConsumptionPayment.js é a checagem
    // canônica já usada em todo o resto do sistema pra essa mesma pergunta.
    const withoutPrepaidConsumption = rawCandidates.filter(p => !isPackageConsumptionPayment(p));

    // Legado sem cobertura de ledger — categoria separada, nunca conta como
    // inconsistência (ver LEDGER_ADOPTION_CUTOFF acima).
    const legacyCandidates = withoutPrepaidConsumption.filter(p => p.createdAt < LEDGER_ADOPTION_CUTOFF);
    const candidates = withoutPrepaidConsumption.filter(p => p.createdAt >= LEDGER_ADOPTION_CUTOFF);

    if (legacyCandidates.length > 0) {
        console.log(`[ReconciliationWorker] ${legacyCandidates.length} Payment(s) anteriores à adoção do ledger (< ${LEDGER_ADOPTION_CUTOFF.toISOString().slice(0,10)}) — legado sem cobertura, não avaliados como inconsistência.`);
        results.legacyPreLedgerCount = (results.legacyPreLedgerCount || 0) + legacyCandidates.length;
    }

    if (candidates.length === 0) return;

    const paymentIds = candidates.map(p => p._id);
    const [credits, adjustments] = await Promise.all([
        FinancialLedger.find({ payment: { $in: paymentIds }, type: { $in: CASH_LEDGER_TYPES } })
            .select('_id payment amount direction').lean(),
        FinancialLedger.find({ payment: { $in: paymentIds }, type: { $in: CASH_ADJUSTMENT_TYPES } })
            .select('_id payment amount direction reversalOfEntryId').lean()
    ]);

    const creditsByPayment = new Map();
    for (const c of credits) {
        const key = c.payment.toString();
        if (!creditsByPayment.has(key)) creditsByPayment.set(key, []);
        creditsByPayment.get(key).push(c);
    }
    const adjustmentsByPayment = new Map();
    for (const a of adjustments) {
        const key = a.payment?.toString();
        if (!key) continue;
        if (!adjustmentsByPayment.has(key)) adjustmentsByPayment.set(key, []);
        adjustmentsByPayment.get(key).push(a);
    }

    // Nenhum crédito pode ser revertido duas vezes — checagem de sanidade
    // além da garantia de índice único do schema (dado histórico pode ter
    // sido escrito antes do índice existir).
    const reversalTargetCounts = new Map();
    for (const a of adjustments) {
        if (!a.reversalOfEntryId) continue;
        const key = a.reversalOfEntryId.toString();
        reversalTargetCounts.set(key, (reversalTargetCounts.get(key) || 0) + 1);
    }
    for (const [creditId, count] of reversalTargetCounts.entries()) {
        if (count > 1) {
            results.inconsistencies++;
            results.manualReview.push({
                type: 'credit-reversed-more-than-once',
                creditEntryId: creditId,
                reversalCount: count,
                severity: 'high'
            });
        }
    }

    results.checked += candidates.length;

    for (const payment of candidates) {
        const key = payment._id.toString();
        const paymentCredits = creditsByPayment.get(key) || [];
        const paymentAdjustments = adjustmentsByPayment.get(key) || [];
        // direction determina o sinal — nunca presumir pelo nome do tipo.
        const netCredit = [...paymentCredits, ...paymentAdjustments]
            .reduce((sum, e) => sum + (e.direction === 'credit' ? e.amount : -e.amount), 0);

        if (payment.status === 'paid') {
            if (Math.abs(netCredit - payment.amount) <= 0.01) continue;

            if (netCredit === 0) {
                // Faltando por completo — auto-fix seguro: cria o crédito
                // canônico (idempotente por ciclo, ver financialLedgerService.js).
                try {
                    await recordPaymentReceived(payment, { correlationId: `recon_${payment._id}_${Date.now()}` });
                    results.autoFixed++;
                    console.log(`[ReconciliationWorker] Auto-fix: Payment ${payment._id} sem crédito → criado`);
                } catch (err) {
                    results.manualReview.push({ type: 'payment-missing-ledger', paymentId: payment._id, amount: payment.amount, error: err.message });
                }
            } else {
                // Crédito líquido existe mas com valor errado — não auto-corrige
                // (pode ser split parcial, glosa, etc. — exige revisão humana).
                results.inconsistencies++;
                results.manualReview.push({
                    type: 'payment-net-credit-mismatch',
                    paymentId: payment._id,
                    expected: payment.amount,
                    netCredit,
                    diff: Math.abs(netCredit - payment.amount)
                });
            }
        } else {
            // pending/canceled/refunded: crédito líquido tem que ser zero.
            if (Math.abs(netCredit) <= 0.01) continue;
            results.inconsistencies++;
            results.manualReview.push({
                type: 'phantom-credit-on-inactive-payment',
                paymentId: payment._id,
                status: payment.status,
                netCredit,
                severity: 'high'
            });
        }
    }
}

/**
 * 🔍 [Verificação 2] Lançamentos órfãos (Payment referenciado não existe mais)
 *
 * NUNCA misturado com a checagem de caixa acima — um órfão não é
 * automaticamente uma divergência de dinheiro (docs/DELETE_CASCADE_CONTRACT.md:
 * o ledger sobrevive de propósito à exclusão de Payment/Package/Patient).
 * Classifica em vez de alarmar:
 *   - legitimate_patient_deletion: Patient também não existe mais.
 *   - legitimate_package_deletion: Package vinculado não existe mais (Patient
 *     ainda existe) — condizente com deletePackageCommand.
 *   - test_data_suspected: valor muito pequeno (<R$1) — mesmo padrão de
 *     poluição de dado de teste já documentado (ADR-016).
 *   - unexplained_orphan: nenhuma trilha de exclusão encontrada — este SIM
 *     precisa de revisão manual.
 */
async function reconcileOrphanLedgerEntries(results, { limit = 500 } = {}) {
    const Patient = (await import('../models/Patient.js')).default;
    const Package = (await import('../models/Package.js')).default;

    const cashEntries = await FinancialLedger.find({ type: { $in: [...CASH_LEDGER_TYPES, ...CASH_ADJUSTMENT_TYPES] }, payment: { $exists: true } })
        .select('_id payment patient package amount type').limit(limit * 3).lean();

    const paymentIds = [...new Set(cashEntries.map(e => e.payment?.toString()).filter(Boolean))].slice(0, limit);
    if (paymentIds.length === 0) return;

    const existingPayments = await Payment.find({ _id: { $in: paymentIds } }).select('_id').lean();
    const existingPaymentIds = new Set(existingPayments.map(p => p._id.toString()));
    const orphanPaymentIds = paymentIds.filter(id => !existingPaymentIds.has(id));
    if (orphanPaymentIds.length === 0) return;

    const orphanEntries = cashEntries.filter(e => orphanPaymentIds.includes(e.payment?.toString()));
    const patientIds = [...new Set(orphanEntries.map(e => e.patient?.toString()).filter(Boolean))];
    const packageIds = [...new Set(orphanEntries.map(e => e.package?.toString()).filter(Boolean))];

    const [existingPatients, existingPackages] = await Promise.all([
        patientIds.length ? Patient.find({ _id: { $in: patientIds } }).select('_id').lean() : [],
        packageIds.length ? Package.find({ _id: { $in: packageIds } }).select('_id').lean() : []
    ]);
    const existingPatientIds = new Set(existingPatients.map(p => p._id.toString()));
    const existingPackageIds = new Set(existingPackages.map(p => p._id.toString()));

    const classification = { legitimate_patient_deletion: 0, legitimate_package_deletion: 0, test_data_suspected: 0, unexplained_orphan: 0 };

    for (const entry of orphanEntries) {
        const patientStillExists = entry.patient && existingPatientIds.has(entry.patient.toString());
        const packageStillExists = entry.package && existingPackageIds.has(entry.package.toString());

        let category;
        if (entry.patient && !patientStillExists) {
            category = 'legitimate_patient_deletion';
        } else if (entry.package && !packageStillExists) {
            category = 'legitimate_package_deletion';
        } else if ((entry.amount || 0) < 1) {
            category = 'test_data_suspected';
        } else {
            category = 'unexplained_orphan';
        }
        classification[category]++;

        if (category === 'unexplained_orphan') {
            results.inconsistencies++;
            results.manualReview.push({
                type: 'orphan-ledger-entry',
                classification: category,
                ledgerEntryId: entry._id,
                paymentId: entry.payment,
                amount: entry.amount,
                ledgerType: entry.type,
                severity: 'medium'
            });
        }
    }

    console.log(`[ReconciliationWorker] Órfãos classificados (${orphanEntries.length} entradas, ${orphanPaymentIds.length} payments):`, classification);
}

/**
 * 🔍 [Verificação 3] Movimento líquido mensal — SÓ o próprio ledger
 *
 * Reporta o movimento de caixa do mês usando exclusivamente data (occurredAt)
 * e sinal (direction) canônicos do próprio FinancialLedger — nunca tenta
 * reconstruir o histórico comparando contra o status ATUAL (mutável) dos
 * Payments, porque uma reversão pode ocorrer num mês diferente do crédito
 * original, e porque Payments deletados legitimamente somem da contagem
 * "atual" sem que o ledger (imutável) tenha motivo pra concordar. É uma
 * métrica de monitoramento, não uma comparação que gera 'inconsistência'.
 */
async function reportMonthlyLedgerNetMovement(results, month) {
    const targetMonth = month || new Date().toISOString().slice(0, 7);
    const startOfMonth = new Date(targetMonth + '-01');
    const endOfMonth = new Date(targetMonth + '-31');

    const agg = await FinancialLedger.aggregate([
        {
            $match: {
                type: { $in: [...CASH_LEDGER_TYPES, ...CASH_ADJUSTMENT_TYPES] },
                occurredAt: { $gte: startOfMonth, $lte: endOfMonth }
            }
        },
        {
            $group: {
                _id: { type: '$type', direction: '$direction' },
                total: { $sum: '$amount' },
                count: { $sum: 1 }
            }
        }
    ]);

    const netMovement = agg.reduce((sum, row) => sum + (row._id.direction === 'credit' ? row.total : -row.total), 0);

    console.log(`[ReconciliationWorker] Movimento líquido do ledger em ${targetMonth}: R$${netMovement.toFixed(2)}`, {
        breakdown: agg.map(r => ({ type: r._id.type, direction: r._id.direction, total: r.total, count: r.count }))
    });

    results.monthlyNetLedgerMovement = { month: targetMonth, netMovement, breakdown: agg };
}

/**
 * 🔍 Verifica Payment ↔ FinancialProjection
 * 
 * Regra: Projection deve refletir suma de payments
 */
async function reconcilePaymentProjection(results, month) {
    const targetMonth = month || new Date().toISOString().slice(0, 7);
    const startOfMonth = new Date(targetMonth + '-01');
    const endOfMonth = new Date(targetMonth + '-31');
    
    // Total de payments — data canônica de caixa é financialDate (fallback
    // paidAt), nunca paymentDate (data em que o registro foi digitado, pode
    // divergir de quando o dinheiro realmente entrou). Ver DOMAIN_INVARIANTS.md,
    // tabela "Campos de data".
    const paymentsTotal = await Payment.aggregate([
        {
            $match: {
                status: 'paid',
                kind: { $ne: 'package_consumed' },
                $expr: {
                    $let: {
                        vars: { cashDate: { $ifNull: ['$financialDate', '$paidAt'] } },
                        in: { $and: [{ $gte: ['$$cashDate', startOfMonth] }, { $lte: ['$$cashDate', endOfMonth] }] }
                    }
                }
            }
        },
        { $group: { _id: null, total: { $sum: '$amount' } } }
    ]).then(r => r[0]?.total || 0);
    
    // Total na projection
    logMetric('FinancialProjection', 'read', { operation: 'reconcilePaymentProjection', month: targetMonth });
    const projection = await FinancialProjection.findOne({
        month: targetMonth,
        type: 'cash'
    }).lean();
    
    const projectionTotal = projection?.data?.total || 0;
    
    const diff = Math.abs(paymentsTotal - projectionTotal);
    
    if (diff > 0.01) {
        console.warn(`[ReconciliationWorker] DIVERGÊNCIA Payment↔Projection: R$${diff}`);
        results.inconsistencies++;
        
        // 🔧 AUTO-FIX: Atualiza projection
        try {
            await FinancialProjection.updateOne(
                { month: targetMonth, type: 'cash' },
                {
                    $set: {
                        'data.total': paymentsTotal,
                        'metadata.reconciledAt': new Date(),
                        'metadata.reconciledDiff': diff
                    }
                },
                { upsert: true }
            );
            results.autoFixed++;
            console.log(`[ReconciliationWorker] Auto-fix: Projection atualizada`);
        } catch (err) {
            results.manualReview.push({
                type: 'projection-mismatch',
                paymentsTotal,
                projectionTotal,
                error: err.message
            });
        }
    }
}

/**
 * 🔍 Verifica PatientBalance (amostragem)
 * 
 * Verifica uma amostra de pacientes com saldo
 */
async function reconcilePatientBalance(results) {
    // Pega pacientes com saldo mais recente
    const balances = await PatientBalance.find({
        currentBalance: { $ne: 0 }
    }).limit(100).lean();
    
    for (const balance of balances) {
        // Soma transações não pagas
        const unpaidDebits = balance.transactions
            ?.filter(t => t.type === 'debit' && !t.isPaid)
            ?.reduce((sum, t) => sum + (t.amount || 0), 0) || 0;
        
        const unpaidCredits = balance.transactions
            ?.filter(t => t.type === 'credit' && !t.applied)
            ?.reduce((sum, t) => sum + (t.amount || 0), 0) || 0;

        // 🩹 Convenção de PatientBalance.currentBalance (models/PatientBalance.js:121):
        // positivo = devedor, negativo = credor. A fórmula estava invertida
        // (unpaidCredits - unpaidDebits), gerando falso positivo de sinal
        // trocado em ~35 de 36 pacientes verificados a cada rodada — achado
        // validando o log real de 2026-08-26. Esta função só loga (manualReview),
        // nunca escreve; fix é só correção do comparador, não do dado.
        const expectedBalance = unpaidDebits - unpaidCredits;
        
        if (Math.abs(balance.currentBalance - expectedBalance) > 0.01) {
            results.inconsistencies++;
            results.manualReview.push({
                type: 'patient-balance-mismatch',
                patientId: balance.patient,
                currentBalance: balance.currentBalance,
                expectedBalance,
                diff: Math.abs(balance.currentBalance - expectedBalance)
            });
        }
    }
    
    results.checked += balances.length;
}

// Exposto só para teste de integração real do redesenho (não é API pública
// do worker) — ver tests/unit/reconciliationWorker.redesign.test.js.
export const __testables = { reconcilePaymentNetCredit, reconcileOrphanLedgerEntries, reportMonthlyLedgerNetMovement };

export default { startReconciliationWorker };
