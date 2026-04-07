// routes/dailySummary.v2.js
/**
 * Daily Summary V2 - Resumo operacional diário (projection-based)
 * 
 * GET /api/v2/daily-summary?date=2026-04-04
 * Retorna: caixa, atendimentos, receita do dia (para conferência da secretária)
 */

import express from 'express';
import moment from 'moment-timezone';
import Payment from '../models/Payment.js';
import Appointment from '../models/Appointment.js';
import { createContextLogger } from '../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();
const TIMEZONE = 'America/Sao_Paulo';

// ======================================================
// GET /v2/daily-summary - Resumo diário operacional
// ======================================================
router.get('/', async (req, res) => {
    const correlationId = req.headers['x-correlation-id'] || uuidv4();
    const log = createContextLogger(correlationId, 'daily_summary_v2');
    
    try {
        const { date } = req.query;
        const targetDate = date 
            ? moment.tz(date, 'YYYY-MM-DD', TIMEZONE) 
            : moment.tz(TIMEZONE);
        
        const dateStr = targetDate.format('YYYY-MM-DD');
        const startOfDay = targetDate.clone().startOf('day').toDate();
        const endOfDay = targetDate.clone().endOf('day').toDate();
        
        log.info('daily_summary_requested', `Resumo diário: ${dateStr}`, {
            startOfDay: startOfDay.toISOString(),
            endOfDay: endOfDay.toISOString()
        });

        // ======================================================
        // 📊 AGGREGATE PARALELO: Caixa + Atendimentos
        // ======================================================
        
        // 🔧 CORREÇÃO: Query por range de datas (paymentDate é Date, não string)
        const paymentDateQuery = {
            $gte: startOfDay,
            $lte: endOfDay
        };
        
        // 🔍 DEBUG: Contar total de pagamentos no dia
        const totalPaymentsDebug = await Payment.countDocuments({
            paymentDate: paymentDateQuery
        });
        log.info('debug_payments_total', `Total payments encontrados: ${totalPaymentsDebug}`);
        
        // 🔍 DEBUG: Contar pagamentos paid
        const paidPaymentsDebug = await Payment.countDocuments({
            status: 'paid',
            paymentDate: paymentDateQuery
        });
        log.info('debug_payments_paid', `Payments PAID encontrados: ${paidPaymentsDebug}`);
        
        const [cashResult, appointmentsResult, productionResult] = await Promise.all([
            // 💰 CAIXA DO DIA: Pagamentos recebidos
            Payment.aggregate([
                {
                    $match: {
                        status: 'paid',
                        paymentDate: paymentDateQuery
                    }
                },
                {
                    $group: {
                        _id: null,
                        totalReceived: { $sum: '$amount' },
                        count: { $sum: 1 },
                        byMethod: {
                            $push: {
                                method: '$paymentMethod',
                                amount: '$amount'
                            }
                        }
                    }
                }
            ]),
            
            // 📅 ATENDIMENTOS DO DIA
            Appointment.aggregate([
                {
                    $match: {
                        date: { $gte: startOfDay, $lte: endOfDay },
                        isDeleted: { $ne: true }
                    }
                },
                {
                    $group: {
                        _id: '$status',
                        count: { $sum: 1 },
                        value: { $sum: '$value' }
                    }
                }
            ]),
            
            // 📊 PRODUÇÃO DO DIA: Tudo que foi realizado (inclui convênios)
            Payment.aggregate([
                {
                    $match: {
                        status: { $in: ['paid', 'pending'] },
                        paymentDate: paymentDateQuery
                    }
                },
                {
                    $group: {
                        _id: null,
                        totalProduction: { $sum: '$amount' },
                        insurancePending: {
                            $sum: {
                                $cond: [
                                    { $eq: ['$insurance.status', 'pending_billing'] },
                                    '$amount', 0
                                ]
                            }
                        },
                        insuranceBilled: {
                            $sum: {
                                $cond: [
                                    { $eq: ['$insurance.status', 'billed'] },
                                    '$amount', 0
                                ]
                            }
                        }
                    }
                }
            ])
        ]);

        // Processar resultados
        const cash = cashResult[0] || { totalReceived: 0, count: 0, byMethod: [] };
        const production = productionResult[0] || { 
            totalProduction: 0, insurancePending: 0, insuranceBilled: 0 
        };
        
        // Consolidar métodos de pagamento
        const byMethod = {};
        cash.byMethod.forEach(m => {
            byMethod[m.method] = (byMethod[m.method] || 0) + m.amount;
        });

        // Consolidar atendimentos por status
        const appointments = {
            scheduled: 0, confirmed: 0, completed: 0, canceled: 0, noShow: 0,
            totalValue: 0
        };
        appointmentsResult.forEach(group => {
            const status = group._id;
            if (appointments.hasOwnProperty(status)) {
                appointments[status] = group.count;
                appointments.totalValue += group.value || 0;
            }
        });

        const summary = {
            date: dateStr,
            cash: {
                received: cash.totalReceived || 0,
                count: cash.count || 0,
                byMethod: {
                    pix: byMethod.pix || 0,
                    cash: byMethod.cash || byMethod.dinheiro || 0,
                    card: byMethod.card || byMethod.credit_card || byMethod.debit_card || 0,
                    transfer: byMethod.transfer || 0
                }
            },
            appointments: {
                scheduled: appointments.scheduled + appointments.confirmed + appointments.completed + appointments.canceled + appointments.noShow,
                completed: appointments.completed,
                noShow: appointments.noShow,
                canceled: appointments.canceled
            },
            revenue: {
                production: production.totalProduction || 0,
                received: cash.totalReceived || 0,
                insurance: (production.insurancePending || 0) + (production.insuranceBilled || 0),
                pending: (production.totalProduction || 0) - (cash.totalReceived || 0)
            }
        };

        log.info('daily_summary_calculated', `Resumo calculado: ${dateStr}`, {
            cashReceived: summary.cash.received,
            appointmentsCompleted: summary.appointments.completed
        });

        return res.json({
            success: true,
            data: summary,
            source: 'v2_aggregate',
            correlationId
        });

    } catch (error) {
        log.error('daily_summary_error', error.message);
        return res.status(500).json({
            success: false,
            error: error.message,
            correlationId
        });
    }
});

export default router;
