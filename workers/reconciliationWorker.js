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
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import mongoose from 'mongoose';

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
                    await reconcilePaymentLedger(results, month);
                    break;
                case 'payment-projection':
                    await reconcilePaymentProjection(results, month);
                    break;
                case 'full':
                default:
                    await reconcilePaymentLedger(results, month);
                    await reconcilePaymentProjection(results, month);
                    await reconcilePatientBalance(results);
            }
            
            // Log resultado
            console.log(`[ReconciliationWorker] Concluído:`, {
                checked: results.checked,
                inconsistencies: results.inconsistencies,
                autoFixed: results.autoFixed
            });
            
            // Se tem inconsistências graves, publica alerta
            if (results.manualReview.length > 0) {
                await publishEvent(
                    'RECONCILIATION_ALERT',
                    {
                        severity: results.manualReview.length > 5 ? 'high' : 'medium',
                        issues: results.manualReview,
                        summary: {
                            checked: results.checked,
                            inconsistencies: results.inconsistencies,
                            autoFixed: results.autoFixed
                        }
                    },
                    { correlationId }
                );
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

/**
 * 🔍 Verifica Payment ↔ Ledger
 * 
 * Regra: Soma de payments 'paid' no mês deve = Soma de créditos no Ledger
 */
async function reconcilePaymentLedger(results, month) {
    const targetMonth = month || new Date().toISOString().slice(0, 7);
    const startOfMonth = new Date(targetMonth + '-01');
    const endOfMonth = new Date(targetMonth + '-31');
    
    // 1. Total de payments pagos no mês
    const paymentsAgg = await Payment.aggregate([
        {
            $match: {
                status: 'paid',
                paymentDate: { $gte: startOfMonth, $lte: endOfMonth }
            }
        },
        {
            $group: {
                _id: null,
                total: { $sum: '$amount' },
                count: { $sum: 1 },
                ids: { $push: '$_id' }
            }
        }
    ]);
    
    const paymentsTotal = paymentsAgg[0]?.total || 0;
    const paymentsCount = paymentsAgg[0]?.count || 0;
    const paymentIds = paymentsAgg[0]?.ids || [];
    
    // 2. Total no Ledger (créditos de payment_received + package_purchase)
    const ledgerAgg = await FinancialLedger.aggregate([
        {
            $match: {
                type: { $in: ['payment_received', 'package_purchase'] },
                occurredAt: { $gte: startOfMonth, $lte: endOfMonth }
            }
        },
        {
            $group: {
                _id: null,
                total: { $sum: '$amount' },
                count: { $sum: 1 }
            }
        }
    ]);
    
    const ledgerTotal = ledgerAgg[0]?.total || 0;
    const ledgerCount = ledgerAgg[0]?.count || 0;
    
    results.checked += paymentsCount;
    
    // 3. Compara
    const diff = Math.abs(paymentsTotal - ledgerTotal);
    const tolerance = 0.01; // tolerância de centavos
    
    if (diff > tolerance) {
        console.warn(`[ReconciliationWorker] DIVERGÊNCIA Payment↔Ledger: R$${diff}`, {
            payments: paymentsTotal,
            ledger: ledgerTotal
        });
        
        results.inconsistencies++;
        
        // 🔧 AUTO-FIX: Se Ledger está menor, recria os lançamentos faltantes
        if (ledgerTotal < paymentsTotal) {
            const missingPayments = await Payment.find({
                _id: { $in: paymentIds },
                status: 'paid'
            }).lean();
            
            for (const payment of missingPayments) {
                const existsInLedger = await FinancialLedger.exists({
                    payment: payment._id,
                    type: { $in: ['payment_received', 'package_purchase'] }
                });
                
                if (!existsInLedger) {
                    // Recria lançamento
                    try {
                        const { recordPaymentReceived } = await import('../services/financialLedgerService.js');
                        const autoCorrelationId = payment.correlationId || `recon_${payment._id}_${Date.now()}`;
                        await recordPaymentReceived(payment, { 
                            correlationId: autoCorrelationId,
                            source: 'reconciliation_auto_fix' 
                        });
                        results.autoFixed++;
                        console.log(`[ReconciliationWorker] Auto-fix: Payment ${payment._id} → Ledger`);
                    } catch (err) {
                        results.manualReview.push({
                            type: 'payment-missing-ledger',
                            paymentId: payment._id,
                            amount: payment.amount,
                            error: err.message
                        });
                    }
                }
            }
        } else {
            // Ledger maior que payments - anomalia grave
            results.manualReview.push({
                type: 'ledger-exceeds-payments',
                paymentsTotal,
                ledgerTotal,
                diff,
                severity: 'high'
            });
        }
    }
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
    
    // Total de payments
    const paymentsTotal = await Payment.aggregate([
        { $match: { status: 'paid', paymentDate: { $gte: startOfMonth, $lte: endOfMonth } } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
    ]).then(r => r[0]?.total || 0);
    
    // Total na projection
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
        
        const expectedBalance = unpaidCredits - unpaidDebits;
        
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

export default { startReconciliationWorker };
