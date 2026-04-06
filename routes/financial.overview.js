/**
 * Financial Overview API V2
 * 
 * Endpoint único para visão financeira consolidada
 * Substitui: /v2/payments, /v2/cashflow
 * 
 * GET /api/v2/financial/overview?startDate=2026-04-01&endDate=2026-04-30
 */

import express from 'express';
import Payment from '../models/Payment.js';
import { auth } from '../middleware/auth.js';

const router = express.Router();

/**
 * Helper: Converte array de key-value para objeto
 */
function mapKeyValue(arr) {
    return arr.reduce((acc, item) => {
        acc[item._id || 'unknown'] = item.total || 0;
        return acc;
    }, {});
}

/**
 * Helper: Busca contagem por status
 */
function getCount(statusCounts, status) {
    const item = statusCounts.find(s => s._id === status);
    return item ? item.count : 0;
}

/**
 * GET /api/v2/financial/overview
 * 
 * Query params:
 * - startDate: YYYY-MM-DD (opcional, default: início do mês)
 * - endDate: YYYY-MM-DD (opcional, default: hoje)
 * - month: YYYY-MM (alternativo ao range, ex: 2026-04)
 */
router.get('/overview', auth, async (req, res) => {
    try {
        const { startDate, endDate, month } = req.query;
        
        let dateFilter = {};
        
        // Se veio month, calcula o range
        if (month && /^\d{4}-\d{2}$/.test(month)) {
            const start = new Date(`${month}-01T00:00:00.000Z`);
            const end = new Date(start);
            end.setMonth(end.getMonth() + 1);
            
            dateFilter = {
                createdAt: {
                    $gte: start,
                    $lt: end
                }
            };
        } 
        // Se veio range de datas
        else if (startDate && endDate) {
            dateFilter = {
                createdAt: {
                    $gte: new Date(startDate),
                    $lte: new Date(`${endDate}T23:59:59.999Z`)
                }
            };
        }
        // Default: mês atual
        else {
            const now = new Date();
            const start = new Date(now.getFullYear(), now.getMonth(), 1);
            const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
            
            dateFilter = {
                createdAt: {
                    $gte: start,
                    $lte: end
                }
            };
        }

        // 🚀 AGGREGATION: Tudo em uma query
        const [data] = await Payment.aggregate([
            { $match: dateFilter },
            {
                $facet: {
                    // Totais principais
                    totals: [
                        {
                            $group: {
                                _id: null,
                                produced: { $sum: '$amount' },
                                received: { $sum: { $ifNull: ['$receivedAmount', 0] } }
                            }
                        }
                    ],
                    
                    // Contagem por status
                    statusCounts: [
                        {
                            $group: {
                                _id: '$status',
                                count: { $sum: 1 }
                            }
                        }
                    ],
                    
                    // Breakdown por método de pagamento
                    byMethod: [
                        {
                            $group: {
                                _id: '$paymentMethod',
                                total: { $sum: { $ifNull: ['$receivedAmount', '$amount', 0] } }
                            }
                        }
                    ],
                    
                    // Breakdown por tipo/fonte
                    byType: [
                        {
                            $group: {
                                _id: '$source',
                                total: { $sum: { $ifNull: ['$receivedAmount', '$amount', 0] } }
                            }
                        }
                    ],
                    
                    // Lista de pagamentos (limitada)
                    recentPayments: [
                        { $sort: { createdAt: -1 } },
                        { $limit: 100 },
                        {
                            $project: {
                                _id: 1,
                                amount: 1,
                                receivedAmount: 1,
                                status: 1,
                                paymentMethod: 1,
                                source: 1,
                                createdAt: 1,
                                patient: 1,
                                appointment: 1
                            }
                        }
                    ]
                }
            }
        ]);

        const totals = data.totals[0] || { produced: 0, received: 0 };
        
        // Mapeia métodos para nomes padronizados
        const rawByMethod = mapKeyValue(data.byMethod);
        const byMethod = {
            pix: rawByMethod.pix || rawByMethod.PIX || 0,
            card: rawByMethod.cartao || rawByMethod.card || rawByMethod['cartão'] || 0,
            cash: rawByMethod.dinheiro || rawByMethod.cash || 0,
            transfer: rawByMethod.transferencia || rawByMethod.transfer || 0,
            insurance: rawByMethod.convenio || rawByMethod.insurance || 0,
            other: rawByMethod.outro || rawByMethod.other || rawByMethod.unknown || 0
        };
        
        // Mapeia tipos para nomes padronizados
        const rawByType = mapKeyValue(data.byType);
        const byType = {
            particular: rawByType.appointment || rawByType.particular || 0,
            package: rawByType.package || rawByType.pacote || 0,
            insurance: rawByType.insurance || rawByType.convenio || 0,
            manual: rawByType.manual || 0
        };

        const overview = {
            success: true,
            
            // Totais principais
            produced: totals.produced,
            received: totals.received,
            pending: Math.max(0, totals.produced - totals.received),
            
            // Contagens
            countPaid: getCount(data.statusCounts, 'paid'),
            countPartial: getCount(data.statusCounts, 'partial'),
            countPending: getCount(data.statusCounts, 'pending'),
            countCanceled: getCount(data.statusCounts, 'canceled'),
            totalCount: data.statusCounts.reduce((sum, s) => sum + s.count, 0),
            
            // Breakdowns
            byMethod,
            byType,
            
            // Dados crus para flexibilidade
            recentPayments: data.recentPayments,
            
            // Metadados
            period: dateFilter.createdAt
        };

        res.json(overview);

    } catch (error) {
        console.error('[FinancialOverview] Erro:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            code: 'FINANCIAL_OVERVIEW_ERROR'
        });
    }
});

export default router;
