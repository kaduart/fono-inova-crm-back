// routes/totals.v2.js
/**
 * Rotas V2 para Totals - Event-driven
 * 
 * GET /v2/totals - Retorna snapshot (ou fallback para cálculo síncrono)
 * POST /v2/totals/recalculate - Solicita recálculo assíncrono
 * GET /v2/totals/status/:date - Status do cálculo
 */

import express from 'express';
import moment from 'moment-timezone';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import TotalsSnapshot from '../models/TotalsSnapshot.js';
import Payment from '../models/Payment.js';
import PackagesView from '../models/PackagesView.js';  // 📦 CQRS Read Model
import PatientBalance from '../models/PatientBalance.js';
import { createContextLogger } from '../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

// ======================================================
// GET /v2/totals - Retorna totais (snapshot ou fallback)
// ======================================================
router.get('/', async (req, res) => {
    const correlationId = req.headers['x-correlation-id'] || uuidv4();
    const log = createContextLogger(correlationId, 'totals_v2');
    
    try {
        const { clinicId, date, period = 'month', forceRecalculate } = req.query;
        const targetDate = date ? moment.tz(date, "America/Sao_Paulo") : moment.tz("America/Sao_Paulo");
        const dateStr = targetDate.format('YYYY-MM-DD');
        
        log.info('totals_requested', `Buscando totais: ${dateStr}`, { clinicId, period });

        // 🔹 ESTRATÉGIA 1: Busca snapshot
        let snapshot = await TotalsSnapshot.findOne({
            clinicId: clinicId || 'default',
            date: dateStr,
            period
        });

        // Se snapshot existe e não está stale, retorna
        const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutos
        const isStale = snapshot && (Date.now() - snapshot.calculatedAt.getTime() > STALE_THRESHOLD_MS);
        
        if (snapshot && !isStale && !forceRecalculate) {
            log.info('snapshot_hit', `Snapshot encontrado: ${dateStr}`);
            return res.json({
                success: true,
                data: {
                    totals: snapshot.totals,
                    period,
                    date: dateStr,
                    calculatedAt: snapshot.calculatedAt,
                    source: 'snapshot'
                },
                correlationId
            });
        }

        // 🔹 ESTRATÉGIA 2: Fallback síncrono (legado)
        log.info('snapshot_miss', `Calculando síncrono: ${dateStr}`);
        
        const now = targetDate;
        let rangeStart, rangeEnd;

        switch (period) {
            case "day":
                rangeStart = now.clone().startOf('day').toDate();
                rangeEnd = now.clone().endOf('day').toDate();
                break;
            case "week":
                rangeStart = now.clone().startOf('week').toDate();
                rangeEnd = now.clone().endOf('week').toDate();
                break;
            case "month":
                rangeStart = now.clone().startOf('month').toDate();
                rangeEnd = now.clone().endOf('month').toDate();
                break;
            case "year":
                rangeStart = now.clone().startOf('year').toDate();
                rangeEnd = now.clone().endOf('year').toDate();
                break;
            default:
                rangeStart = now.clone().startOf('month').toDate();
                rangeEnd = now.clone().endOf('month').toDate();
        }

        const matchStage = {
            status: { $ne: 'canceled' },
            $or: [
                {
                    paymentDate: {
                        $gte: rangeStart.toISOString().split('T')[0],
                        $lte: rangeEnd.toISOString().split('T')[0]
                    }
                },
                {
                    paymentDate: { $exists: false },
                    createdAt: { $gte: rangeStart, $lte: rangeEnd }
                }
            ]
        };

        if (clinicId) matchStage.clinicId = clinicId;

        // ======================================================
        // 📦 AGGREGATE PARALELO: Payments + Packages + PatientBalance
        // ======================================================
        const [paymentResult, packageResult, balanceResult] = await Promise.all([
            // 💰 PAYMENTS: Caixa e Produção
            Payment.aggregate([
                { $match: matchStage },
                {
                    $group: {
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
                        totalPending: { 
                            $sum: { $cond: [{ $eq: ["$status", "pending"] }, "$amount", 0] } 
                        },
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
                        countPending: { 
                            $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } 
                        },
                        particularReceived: {
                            $sum: {
                                $cond: [
                                    { $and: [
                                        { $eq: ["$status", "paid"] },
                                        { $ne: ["$billingType", "convenio"] }
                                    ]},
                                    "$amount", 0
                                ]
                            }
                        },
                        insurancePendingBilling: {
                            $sum: { $cond: [{ $eq: ["$insurance.status", "pending_billing"] }, "$amount", 0] }
                        },
                        insuranceBilled: {
                            $sum: { $cond: [{ $eq: ["$insurance.status", "billed"] }, "$amount", 0] }
                        },
                        insuranceReceived: {
                            $sum: { $cond: [{ $eq: ["$insurance.status", "received"] }, "$amount", 0] }
                        }
                    }
                }
            ]),
            
            // 📦 PACKAGES: Usar PackagesView (CQRS - já otimizado para leitura)
            // ⚠️ Importante: recognizedRevenue é proporcional ao valor do pacote, não avulso
            PackagesView.aggregate([
                {
                    $match: {
                        status: { $in: ['active', 'finished'] }  // Pacotes ativos ou finalizados
                    }
                },
                {
                    $group: {
                        _id: null,
                        // 💰 Contrato e Caixa (semântica clara)
                        contractedRevenue: { $sum: "$totalValue" },  // 📄 Valor contratado (venda)
                        cashReceived: { $sum: "$totalPaid" },        // 💰 Valor efetivamente recebido
                        
                        // 📊 Receita Diferida (obrigação futura)
                        deferredSessions: { $sum: "$sessionsRemaining" },
                        // ⚠️ deferredRevenue = proporcional ao pacote (sessionValue já é do pacote)
                        deferredRevenue: { 
                            $sum: { $multiply: ["$sessionsRemaining", "$sessionValue"] }
                        },
                        
                        // 📊 Receita Reconhecida (já executada)
                        recognizedSessions: { $sum: "$sessionsUsed" },
                        // ⚠️ recognizedRevenue = proporcional ao pacote (não ao preço avulso)
                        recognizedRevenue: {
                            $sum: { $multiply: ["$sessionsUsed", "$sessionValue"] }
                        },
                        
                        // Totais
                        totalSessions: { $sum: "$totalSessions" },
                        activePackages: { $sum: 1 }
                    }
                }
            ]),
            
            // 📄 PATIENT BALANCE: Conta corrente (débitos/créditos avulsos)
            PatientBalance.aggregate([
                {
                    $group: {
                        _id: null,
                        totalDebt: {
                            $sum: {
                                $cond: [{ $gt: ["$currentBalance", 0] }, "$currentBalance", 0]
                            }
                        },
                        totalCredit: {
                            $sum: {
                                $cond: [{ $lt: ["$currentBalance", 0] }, { $multiply: ["$currentBalance", -1] }, 0]
                            }
                        },
                        totalDebited: { $sum: "$totalDebited" },
                        totalCredited: { $sum: "$totalCredited" },
                        patientsWithDebt: {
                            $sum: { $cond: [{ $gt: ["$currentBalance", 0] }, 1, 0] }
                        },
                        patientsWithCredit: {
                            $sum: { $cond: [{ $lt: ["$currentBalance", 0] }, 1, 0] }
                        }
                    }
                }
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
            // 📦 NOVO: Package Credit (Receita Diferida)
            packageCredit: {
                // 💰 Contrato e Caixa
                contractedRevenue: pkg.contractedRevenue || 0,  // 📄 Valor contratado (venda)
                cashReceived: pkg.cashReceived || 0,            // 💰 Dinheiro efetivamente recebido
                
                // 📊 Receita Diferida (obrigação futura)
                deferredRevenue: Math.max(0, pkg.deferredRevenue || 0),
                deferredSessions: Math.max(0, pkg.deferredSessions || 0),
                
                // 📊 Receita Reconhecida (já executada via pacote)
                recognizedRevenue: pkg.recognizedRevenue || 0,
                recognizedSessions: pkg.recognizedSessions || 0,
                
                // Totais
                totalSessions: pkg.totalSessions || 0,
                activePackages: pkg.activePackages || 0
            },
            // 📄 NOVO: Patient Balance (Conta Corrente)
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
        // 🔍 VALIDAÇÃO DE CONSISTÊNCIA (CRÍTICO)
        // ======================================================
        const validations = [];
        
        // 1. Caixa total deve ser >= caixa de pacote (não pode receber mais de pacote que o total)
        // Isso detecta: pagamento duplicado, pacote sem payment, etc
        if (totals.totalReceived < totals.packageCredit.cashReceived * 0.99) {
            validations.push({
                type: 'warning',
                code: 'CASH_MISMATCH',
                message: 'Caixa total menor que caixa de pacotes (pode indicar pagamento duplicado)',
                details: {
                    totalReceived: totals.totalReceived,
                    packageCashReceived: totals.packageCredit.cashReceived
                }
            });
        }
        
        // 2. contractedRevenue = deferredRevenue + recognizedRevenue (sempre!)
        const expectedContracted = totals.packageCredit.deferredRevenue + totals.packageCredit.recognizedRevenue;
        if (Math.abs(totals.packageCredit.contractedRevenue - expectedContracted) > 1) {
            validations.push({
                type: 'error',
                code: 'PACKAGE_REVENUE_MISMATCH',
                message: 'Inconsistência: contratado ≠ diferido + reconhecido',
                details: {
                    contracted: totals.packageCredit.contractedRevenue,
                    deferred: totals.packageCredit.deferredRevenue,
                    recognized: totals.packageCredit.recognizedRevenue,
                    expected: expectedContracted
                }
            });
        }
        
        // 3. Produção deve incluir recognizedRevenue
        // Produção mínima = particular pago + convênio tudo + pacote reconhecido
        const minProduction = totals.particularReceived + 
                             totals.insurancePendingBilling + 
                             totals.insuranceBilled + 
                             totals.insuranceReceived +
                             totals.packageCredit.recognizedRevenue;
        if (totals.totalProduction < minProduction * 0.95) {
            validations.push({
                type: 'warning',
                code: 'PRODUCTION_LOW',
                message: 'Produção total menor que soma das partes',
                details: {
                    totalProduction: totals.totalProduction,
                    minExpected: minProduction
                }
            });
        }
        
        // Log warnings se houver
        if (validations.length > 0) {
            log.warn('totals_validation_warnings', 'Validações encontradas', { 
                validations,
                correlationId 
            });
        }

        // Se snapshot estava stale, dispara recálculo em background
        if (isStale || forceRecalculate) {
            const eventId = uuidv4();
            await publishEvent(EventTypes.TOTALS_RECALCULATE_REQUESTED, {
                clinicId,
                date: dateStr,
                period,
                reason: isStale ? 'stale_snapshot' : 'force_recalculate'
            }, { correlationId, eventId });
            
            log.info('recalculate_triggered', `Recálculo em background: ${dateStr}`);
        }

        // Separar validações por severidade para o frontend
        const blockingErrors = validations.filter(v => v.type === 'error');
        const warnings = validations.filter(v => v.type === 'warning');
        
        return res.json({
            success: true,
            data: {
                totals: {
                    totalReceived: totals.totalReceived,           // 💰 Caixa real
                    totalProduction: totals.totalProduction,       // 📊 Tudo produzido
                    totalPending: totals.totalPending,
                    countReceived: totals.countReceived,
                    countPending: totals.countPending,
                    particularReceived: totals.particularReceived, // 💰 Particular
                    // 🏥 Convênio
                    insurance: {
                        pendingBilling: totals.insurancePendingBilling || 0,
                        billed: totals.insuranceBilled || 0,
                        received: totals.insuranceReceived || 0
                    },
                    // 📦 NOVO: Crédito de Pacotes (Receita Diferida)
                    packageCredit: totals.packageCredit,
                    // 📄 NOVO: Conta Corrente de Pacientes
                    patientBalance: totals.patientBalance
                },
                // 📅 Time Dimension (para rastreabilidade)
                period,
                date: dateStr,
                periodStart: rangeStart.toISOString(),
                periodEnd: rangeEnd.toISOString(),
                source: 'sync_fallback',
                backgroundUpdate: isStale || forceRecalculate,
                // 🔍 Validações de consistência (por severidade)
                blockingErrors: blockingErrors.length > 0 ? blockingErrors : undefined,
                warnings: warnings.length > 0 ? warnings : undefined
            },
            correlationId
        });

    } catch (error) {
        log.error('totals_error', error.message);
        return res.status(500).json({
            success: false,
            error: error.message,
            correlationId
        });
    }
});

// ======================================================
// POST /v2/totals/recalculate - Solicita recálculo assíncrono
// ======================================================
router.post('/recalculate', async (req, res) => {
    const correlationId = req.headers['x-correlation-id'] || uuidv4();
    const log = createContextLogger(correlationId, 'totals_v2');
    
    try {
        const { clinicId, date, period = 'month' } = req.body;
        const targetDate = date ? moment.tz(date, "America/Sao_Paulo") : moment.tz("America/Sao_Paulo");
        const dateStr = targetDate.format('YYYY-MM-DD');
        const eventId = uuidv4();

        log.info('recalculate_requested', `Solicitando recálculo: ${dateStr}`);
        console.log(`[TotalsV2] Publicando evento: ${eventId}`);

        try {
            const result = await publishEvent(EventTypes.TOTALS_RECALCULATE_REQUESTED, {
                clinicId,
                date: dateStr,
                period
            }, { correlationId, eventId });
            console.log(`[TotalsV2] Evento publicado:`, result);
        } catch (pubError) {
            console.error(`[TotalsV2] ERRO ao publicar:`, pubError.message);
            throw pubError;
        }

        return res.status(202).json({
            success: true,
            message: 'Recálculo solicitado',
            data: {
                eventId,
                status: 'pending',
                checkStatusUrl: `/api/v2/totals/status/${dateStr}?period=${period}&clinicId=${clinicId || ''}`
            },
            correlationId
        });

    } catch (error) {
        log.error('recalculate_error', error.message);
        return res.status(500).json({
            success: false,
            error: error.message,
            correlationId
        });
    }
});

// ======================================================
// GET /v2/totals/status/:date - Status do cálculo
// ======================================================
router.get('/status/:date', async (req, res) => {
    const correlationId = req.headers['x-correlation-id'] || uuidv4();
    
    try {
        const { date } = req.params;
        const { clinicId, period = 'month' } = req.query;

        // Busca snapshot
        const snapshot = await TotalsSnapshot.findOne({
            clinicId: clinicId || 'default',
            date,
            period
        });

        if (!snapshot) {
            return res.json({
                success: true,
                data: {
                    status: 'not_calculated',
                    date,
                    period,
                    calculatedAt: null
                },
                correlationId
            });
        }

        const STALE_THRESHOLD_MS = 5 * 60 * 1000;
        const isStale = Date.now() - snapshot.calculatedAt.getTime() > STALE_THRESHOLD_MS;

        return res.json({
            success: true,
            data: {
                status: isStale ? 'stale' : 'ready',
                date,
                period,
                calculatedAt: snapshot.calculatedAt,
                totals: snapshot.totals
            },
            correlationId
        });

    } catch (error) {
        return res.status(500).json({
            success: false,
            error: error.message,
            correlationId
        });
    }
});

export default router;
