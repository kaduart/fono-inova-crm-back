// workers/totalsWorker.js
import { Worker } from 'bullmq';
import moment from 'moment-timezone';
import { redisConnection, moveToDLQ } from '../infrastructure/queue/queueConfig.js';
import Payment from '../models/Payment.js';
import PackagesView from '../models/PackagesView.js';  // 📦 CQRS Read Model
import PatientBalance from '../models/PatientBalance.js';
import TotalsSnapshot from '../models/TotalsSnapshot.js';
import { eventExists } from '../infrastructure/events/eventStoreService.js';

export function startTotalsWorker() {
    console.log('[TotalsWorker] Criando worker...');
    
    const worker = new Worker('totals-calculation', async (job) => {
        console.log('[TotalsWorker] JOB RECEBIDO:', job.id);
        
        const { eventId, correlationId, payload } = job.data;
        const { clinicId, date, period = 'month' } = payload;
        
        console.log(`[TotalsWorker] Processando: ${date}, period: ${period}`);

        try {
            // Idempotência
            const idempotencyKey = `totals_${clinicId}_${date}_${period}`;
            if (await eventExists(idempotencyKey)) {
                console.log('[TotalsWorker] Já processado');
                return { status: 'already_processed' };
            }

            // Cálculo
            const now = moment.tz(date, "America/Sao_Paulo");
            const rangeStart = now.clone().startOf('month').toDate();
            const rangeEnd = now.clone().endOf('month').toDate();

            const matchStage = {
                status: { $ne: 'canceled' },
                $or: [
                    { paymentDate: { $gte: rangeStart.toISOString().split('T')[0], $lte: rangeEnd.toISOString().split('T')[0] } },
                    { paymentDate: { $exists: false }, createdAt: { $gte: rangeStart, $lte: rangeEnd } }
                ]
            };
            if (clinicId) matchStage.clinicId = clinicId;

            console.log('[TotalsWorker] Executando aggregation...');
            
            // 📦 AGGREGATE PARALELO: Payments + Packages + PatientBalance
            const [paymentResult, packageResult, balanceResult] = await Promise.all([
                // 💰 PAYMENTS
                Payment.aggregate([
                    { $match: matchStage },
                    { $group: {
                        _id: null,
                        totalReceived: { 
                            $sum: { 
                                $cond: [
                                    { $or: [
                                        { $eq: ["$status", "paid"] },
                                        { $eq: ["$insurance.status", "received"] }
                                    ]}, 
                                    "$amount", 0
                                ] 
                            } 
                        },
                        totalProduction: {
                            $sum: {
                                $cond: [
                                    { $or: [
                                        { $eq: ["$status", "paid"] },
                                        { $in: ["$insurance.status", ["pending_billing", "billed", "received"]] }
                                    ]},
                                    "$amount", 0
                                ]
                            }
                        },
                        totalPending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, "$amount", 0] } },
                        countReceived: { 
                            $sum: { 
                                $cond: [
                                    { $or: [
                                        { $eq: ["$status", "paid"] },
                                        { $eq: ["$insurance.status", "received"] }
                                    ]}, 
                                    1, 0
                                ] 
                            } 
                        },
                        countPending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } },
                        particularReceived: { $sum: { $cond: [{ $and: [{ $eq: ["$status", "paid"] }, { $ne: ["$billingType", "convenio"] }] }, "$amount", 0] } },
                        insurancePendingBilling: { $sum: { $cond: [{ $eq: ["$insurance.status", "pending_billing"] }, "$amount", 0] } },
                        insuranceBilled: { $sum: { $cond: [{ $eq: ["$insurance.status", "billed"] }, "$amount", 0] } },
                        insuranceReceived: { $sum: { $cond: [{ $eq: ["$insurance.status", "received"] }, "$amount", 0] } }
                    }}
                ]),
                
                // 📦 PACKAGES: Usar PackagesView (CQRS - já otimizado)
                // ⚠️ recognizedRevenue proporcional ao pacote (sessionValue do pacote, não avulso)
                PackagesView.aggregate([
                    { $match: { status: { $in: ['active', 'finished'] } } },
                    { $group: {
                        _id: null,
                        // 💰 Contrato e Caixa
                        contractedRevenue: { $sum: "$totalValue" },  // 📄 Valor contratado
                        cashReceived: { $sum: "$totalPaid" },        // 💰 Dinheiro recebido
                        // 📊 Receita Diferida e Reconhecida
                        deferredRevenue: { $sum: { $multiply: ["$sessionsRemaining", "$sessionValue"] } },
                        deferredSessions: { $sum: "$sessionsRemaining" },
                        recognizedRevenue: { $sum: { $multiply: ["$sessionsUsed", "$sessionValue"] } },
                        recognizedSessions: { $sum: "$sessionsUsed" },
                        totalSessions: { $sum: "$totalSessions" },
                        activePackages: { $sum: 1 }
                    }}
                ]),
                
                // 📄 PATIENT BALANCE
                PatientBalance.aggregate([
                    { $group: {
                        _id: null,
                        totalDebt: { $sum: { $cond: [{ $gt: ["$currentBalance", 0] }, "$currentBalance", 0] } },
                        totalCredit: { $sum: { $cond: [{ $lt: ["$currentBalance", 0] }, { $multiply: ["$currentBalance", -1] }, 0] } },
                        totalDebited: { $sum: "$totalDebited" },
                        totalCredited: { $sum: "$totalCredited" },
                        patientsWithDebt: { $sum: { $cond: [{ $gt: ["$currentBalance", 0] }, 1, 0] } },
                        patientsWithCredit: { $sum: { $cond: [{ $lt: ["$currentBalance", 0] }, 1, 0] } }
                    }}
                ])
            ]);
            
            const p = paymentResult[0] || {};
            const pkg = packageResult[0] || {};
            const bal = balanceResult[0] || {};

            const totals = {
                totalReceived: p.totalReceived || 0,
                totalProduction: p.totalProduction || 0,
                totalPending: p.totalPending || 0,
                countReceived: p.countReceived || 0,
                countPending: p.countPending || 0,
                particularReceived: p.particularReceived || 0,
                insurancePendingBilling: p.insurancePendingBilling || 0,
                insuranceBilled: p.insuranceBilled || 0,
                insuranceReceived: p.insuranceReceived || 0,
                packageCredit: {
                    contractedRevenue: pkg.contractedRevenue || 0,
                    cashReceived: pkg.cashReceived || 0,
                    deferredRevenue: Math.max(0, pkg.deferredRevenue || 0),
                    deferredSessions: Math.max(0, pkg.deferredSessions || 0),
                    recognizedRevenue: pkg.recognizedRevenue || 0,
                    recognizedSessions: pkg.recognizedSessions || 0,
                    totalSessions: pkg.totalSessions || 0,
                    activePackages: pkg.activePackages || 0
                },
                patientBalance: {
                    totalDebt: bal.totalDebt || 0,
                    totalCredit: bal.totalCredit || 0,
                    totalDebited: bal.totalDebited || 0,
                    totalCredited: bal.totalCredited || 0,
                    patientsWithDebt: bal.patientsWithDebt || 0,
                    patientsWithCredit: bal.patientsWithCredit || 0
                }
            };
            
            // ======================================================
            // 🔍 VALIDAÇÕES DE CONSISTÊNCIA (com severidade)
            // ======================================================
            const blockingErrors = [];
            const validations = [];
            const insights = [];
            
            // 1. ERRO BLOQUEANTE: Contratado ≠ Diferido + Reconhecido
            const expectedContracted = totals.packageCredit.deferredRevenue + totals.packageCredit.recognizedRevenue;
            if (Math.abs(totals.packageCredit.contractedRevenue - expectedContracted) > 1) {
                blockingErrors.push({
                    code: 'PACKAGE_REVENUE_MISMATCH',
                    message: 'Inconsistência matemática: contratado ≠ diferido + reconhecido',
                    field: 'packageCredit.contractedRevenue',
                    expected: expectedContracted,
                    actual: totals.packageCredit.contractedRevenue
                });
            }
            
            // 2. WARNING: Caixa de pacote > Caixa total (impossível)
            if (totals.packageCredit.cashReceived > totals.totalReceived * 1.01) {
                validations.push({
                    type: 'error',
                    code: 'CASH_IMPOSSIBLE',
                    message: 'Caixa de pacote maior que caixa total',
                    details: {
                        packageCash: totals.packageCredit.cashReceived,
                        totalCash: totals.totalReceived
                    }
                });
            }
            
            // 3. WARNING: Produção < Pacote reconhecido (impossível)
            if (totals.totalProduction < totals.packageCredit.recognizedRevenue * 0.99) {
                validations.push({
                    type: 'warning',
                    code: 'PRODUCTION_BELOW_PACKAGE',
                    message: 'Produção total menor que produção de pacote',
                    details: {
                        totalProduction: totals.totalProduction,
                        packageRecognized: totals.packageCredit.recognizedRevenue
                    }
                });
            }
            
            // 4. INSIGHT: Capacidade vs Obrigação (CRÍTICO para operação)
            // Assumindo capacidade média de 100 sessões/mês por profissional
            // Isso deve ser parametrizável por clínica
            const estimatedCapacity = 400; // TODO: buscar do ClinicConfig
            const utilizationRate = (totals.packageCredit.deferredSessions / estimatedCapacity) * 100;
            
            if (utilizationRate > 80) {
                insights.push({
                    type: 'risk',
                    code: 'CAPACITY_OVERLOAD',
                    message: `Obrigação de pacote consumindo ${utilizationRate.toFixed(1)}% da capacidade`,
                    value: totals.packageCredit.deferredSessions,
                    threshold: estimatedCapacity * 0.8
                });
            } else if (utilizationRate > 50) {
                insights.push({
                    type: 'capacity',
                    code: 'CAPACITY_HIGH',
                    message: `Obrigação de pacote em ${utilizationRate.toFixed(1)}% da capacidade`,
                    value: totals.packageCredit.deferredSessions,
                    threshold: estimatedCapacity * 0.5
                });
            }
            
            // 5. INSIGHT: Dívida de pacientes crítica
            if (totals.patientBalance.totalDebt > totals.totalReceived * 0.1) {
                insights.push({
                    type: 'risk',
                    code: 'DEBT_HIGH',
                    message: 'Dívida de pacientes > 10% do caixa',
                    value: totals.patientBalance.totalDebt,
                    threshold: totals.totalReceived * 0.1
                });
            }
            
            console.log('[TotalsWorker] Totais calculados:', totals);
            console.log('[TotalsWorker] Validações:', { blockingErrors: blockingErrors.length, validations: validations.length, insights: insights.length });
            
            // Se tem erro bloqueante, não salva snapshot (evita dados corrompidos)
            if (blockingErrors.length > 0) {
                console.error('[TotalsWorker] ❌ ERROS BLOQUEANTES:', blockingErrors);
                throw new Error(`Bloqueado: ${blockingErrors.map(e => e.code).join(', ')}`);
            }

            // Salvar snapshot com Time Dimension
            console.log('[TotalsWorker] Salvando snapshot...');
            await TotalsSnapshot.findOneAndUpdate(
                { clinicId: clinicId || 'default', date: now.format('YYYY-MM-DD'), period },
                {
                    clinicId: clinicId || 'default',
                    date: now.format('YYYY-MM-DD'),
                    period,
                    // 📅 Time Dimension (CRÍTICO)
                    periodStart: rangeStart,
                    periodEnd: rangeEnd,
                    competencyDate: new Date(),
                    cashDate: new Date(),
                    totals: {
                        totalReceived: totals.totalReceived,
                        totalProduction: totals.totalProduction,
                        totalPending: totals.totalPending,
                        countReceived: totals.countReceived,
                        countPending: totals.countPending,
                        particularReceived: totals.particularReceived,
                        insurance: {
                            pendingBilling: totals.insurancePendingBilling || 0,
                            billed: totals.insuranceBilled || 0,
                            received: totals.insuranceReceived || 0
                        },
                        packageCredit: totals.packageCredit,
                        patientBalance: totals.patientBalance
                    },
                    // 🔍 Validações com severidade
                    blockingErrors,
                    validations,
                    insights,
                    calculatedAt: new Date(),
                    calculatedBy: 'totals_worker'
                },
                { upsert: true, new: true }
            );

            console.log('[TotalsWorker] ✅ SUCESSO');
            return { status: 'completed', totals };

        } catch (error) {
            console.error('[TotalsWorker] ❌ ERRO:', error.message);
            console.error(error.stack);
            throw error;
        }
    }, {
        connection: redisConnection,
        concurrency: 3,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 }
    });

    worker.on('completed', (job) => console.log('[TotalsWorker] Job completado:', job.id));
    worker.on('failed', (job, err) => console.error('[TotalsWorker] Job falhou:', job?.id, err.message));

    console.log('[TotalsWorker] Worker iniciado');
    return worker;
}

export default startTotalsWorker;
