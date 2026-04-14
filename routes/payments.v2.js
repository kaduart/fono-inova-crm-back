// routes/payments.v2.js
/**
 * API V2 para Payments (Projection otimizada)
 * 
 * GET /api/v2/payments - Lista pagamentos (projection)
 * GET /api/v2/payments/:id - Detalhe de um pagamento
 * POST /api/v2/payments/rebuild - Reconstroi projection (admin)
 */

import express from 'express';
import moment from 'moment-timezone';
import { auth } from '../middleware/auth.js';
import PaymentsView from '../models/PaymentsView.js';
import { rebuildPaymentsProjection } from '../projections/paymentsProjection.js';
import { getSnapshotsForRange, getSnapshotsForMonth, reducePaymentStats } from '../services/financialSnapshot.service.js';

const router = express.Router();
const TIMEZONE = 'America/Sao_Paulo';

// 🆕 V2: feature flag para usar snapshot (permite rollback rápido)
const USE_SNAPSHOT = process.env.FF_PAYMENTS_SNAPSHOT !== 'false';

/**
 * GET /api/v2/payments
 * 
 * Query params:
 * - month: YYYY-MM (ex: 2026-04)
 * - startDate: YYYY-MM-DD
 * - endDate: YYYY-MM-DD
 * - status: paid | pending | partial | all
 * - category: particular | package | insurance | expense | all
 * - method: pix | cash | card | insurance | all
 * - search: texto para buscar paciente/profissional
 * - page: número da página (default: 1)
 * - limit: itens por página (default: 50, max: 200)
 */
router.get('/', auth, async (req, res) => {
    try {
        const {
            month,
            startDate,
            endDate,
            status = 'all',
            category = 'all',
            method = 'all',
            search,
            page = 1,
            limit = 50,
            clinicId = 'default'
        } = req.query;
        
        const correlationId = req.headers['x-correlation-id'] || `payments_v2_${Date.now()}`;
        const startTime = Date.now();
        
        // Build filter
        const filter = {
            clinicId,
            isDeleted: false
        };
        
        // Filtro de data (prioridade: month > startDate/endDate)
        if (month && /^\d{4}-\d{2}$/.test(month)) {
            filter.paymentMonth = month;
        } else if (startDate && endDate) {
            filter.paymentDate = {
                $gte: startDate,
                $lte: endDate
            };
        } else {
            // Default: mês atual
            filter.paymentMonth = moment().tz(TIMEZONE).format('YYYY-MM');
        }
        
        // Filtro de status
        if (status && status !== 'all') {
            filter.status = status;
        }
        
        // Filtro de categoria
        if (category && category !== 'all') {
            filter.category = category;
        }
        
        // Filtro de método
        if (method && method !== 'all') {
            filter.method = method;
        }
        
        // Busca textual
        if (search && search.trim()) {
            filter.$text = { $search: search.trim() };
        }
        
        // Paginação
        const pageNum = Math.max(1, parseInt(page) || 1);
        const limitNum = Math.min(200, Math.max(1, parseInt(limit) || 50));
        const skip = (pageNum - 1) * limitNum;
        
        // Resolve range de datas para snapshot
        let snapshotStart, snapshotEnd;
        if (filter.paymentMonth) {
            snapshotStart = `${filter.paymentMonth}-01`;
            snapshotEnd = moment(snapshotStart).endOf('month').format('YYYY-MM-DD');
        } else if (filter.paymentDate?.$gte && filter.paymentDate?.$lte) {
            snapshotStart = filter.paymentDate.$gte;
            snapshotEnd = filter.paymentDate.$lte;
        } else {
            snapshotStart = moment().tz(TIMEZONE).format('YYYY-MM-DD');
            snapshotEnd = snapshotStart;
        }

        // Execute query com performance tracking
        const [payments, total] = await Promise.all([
            PaymentsView.find(filter)
                .sort({ paymentDate: -1, createdAt: -1 })
                .skip(skip)
                .limit(limitNum)
                .lean(),
            PaymentsView.countDocuments(filter)
        ]);
        
        const executionTime = Date.now() - startTime;
        
        // Formata response
        const formatted = payments.map(p => ({
            _id: p.paymentId,
            viewId: p._id,
            date: p.paymentDate,
            patient: {
                _id: p.patient?.id,
                fullName: p.patient?.name,
                phone: p.patient?.phone
            },
            doctor: {
                _id: p.doctor?.id,
                fullName: p.doctor?.name,
                specialty: p.doctor?.specialty
            },
            serviceType: p.service?.type,
            serviceLabel: p.service?.label,
            specialty: p.specialty,
            amount: p.amount,
            receivedAmount: p.receivedAmount || 0, // 🔥 V2
            remaining: p.amount - (p.receivedAmount || 0), // 🔥 V2
            paymentMethod: p.method,
            paymentMethodLabel: p.methodLabel,
            status: p.status,
            category: p.category,
            notes: p.notes,
            createdAt: p.createdAt,
            appointment: p.appointmentId ? { _id: p.appointmentId } : null,
            package: p.packageId ? { _id: p.packageId } : null
        }));
        
        // 🚀 V2 PURO: stats via snapshot (zero aggregate)
        let stats;
        if (USE_SNAPSHOT) {
            const snapshots = await getSnapshotsForRange(snapshotStart, snapshotEnd, clinicId);
            stats = reducePaymentStats(snapshots);

            // 🛡️ Validação silenciosa: compara com V1 se houver dados divergentes
            if (stats.count === 0 && total > 0) {
                console.warn('[PaymentsV2] Snapshot vazio mas PaymentsView tem dados — fallback para aggregate V1', {
                    clinicId, snapshotStart, snapshotEnd, total
                });
                const totalsV1 = await PaymentsView.aggregate([
                    { $match: filter },
                    {
                        $group: {
                            _id: null,
                            produced: { $sum: '$amount' },
                            received: { $sum: '$receivedAmount' },
                            count: { $sum: 1 },
                            countPaid: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } },
                            countPartial: { $sum: { $cond: [{ $eq: ['$status', 'partial'] }, 1, 0] } },
                            countPending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } }
                        }
                    }
                ]);
                stats = totalsV1[0] || { produced:0, received:0, count:0, countPaid:0, countPartial:0, countPending:0 };
            }
        } else {
            const totals = await PaymentsView.aggregate([
                { $match: filter },
                {
                    $group: {
                        _id: null,
                        produced: { $sum: '$amount' },
                        received: { $sum: '$receivedAmount' },
                        count: { $sum: 1 },
                        countPaid: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } },
                        countPartial: { $sum: { $cond: [{ $eq: ['$status', 'partial'] }, 1, 0] } },
                        countPending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } }
                    }
                }
            ]);
            stats = totals[0] || { produced:0, received:0, count:0, countPaid:0, countPartial:0, countPending:0 };
        }
        
        const pending = stats.produced - stats.received;
        
        res.json({
            success: true,
            correlationId,
            meta: {
                total: stats.count,
                page: pageNum,
                limit: limitNum,
                pages: Math.ceil(stats.count / limitNum),
                executionTime: `${executionTime}ms`
            },
            // 🔥 STATS V2: produced vs received (BI real)
            produced: stats.produced,
            received: stats.received,
            pending: pending,
            countPaid: stats.countPaid,
            countPartial: stats.countPartial,
            countPending: stats.countPending,
            // Legacy (mantido pra compatibilidade)
            summary: {
                totalAmount: stats.produced,
                paidAmount: stats.received,
                pendingAmount: pending
            },
            data: formatted
        });
        
    } catch (error) {
        console.error('[PaymentsV2] Erro:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            code: 'PAYMENTS_QUERY_ERROR'
        });
    }
});

/**
 * GET /api/v2/payments/:id
 * Detalhe de um pagamento específico
 */
router.get('/:id', auth, async (req, res) => {
    try {
        const { id } = req.params;
        
        const payment = await PaymentsView.findOne({
            $or: [
                { paymentId: id },
                { _id: id }
            ],
            isDeleted: false
        }).lean();
        
        if (!payment) {
            return res.status(404).json({
                success: false,
                message: 'Pagamento não encontrado'
            });
        }
        
        res.json({
            success: true,
            data: payment
        });
        
    } catch (error) {
        console.error('[PaymentsV2] Erro ao buscar pagamento:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/v2/payments/rebuild
 * Reconstroi a projection completa (admin only)
 */
router.post('/rebuild', auth, async (req, res) => {
    try {
        // Verifica se é admin
        if (req.user?.role !== 'admin') {
            return res.status(403).json({
                success: false,
                message: 'Acesso negado'
            });
        }
        
        const { clinicId = 'default' } = req.body;
        
        console.log(`[PaymentsV2] Rebuild iniciado por ${req.user.name}`);
        
        const result = await rebuildPaymentsProjection(clinicId);
        
        res.json({
            success: true,
            message: 'Projection reconstituída',
            result
        });
        
    } catch (error) {
        console.error('[PaymentsV2] Erro no rebuild:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/v2/payments/stats/summary
 * Resumo estatístico rápido
 */
router.get('/stats/summary', auth, async (req, res) => {
    try {
        const { month = moment().tz(TIMEZONE).format('YYYY-MM'), clinicId = 'default' } = req.query;
        
        let data;
        if (USE_SNAPSHOT) {
            const snapshots = await getSnapshotsForMonth(month, clinicId);
            const reduced = reducePaymentStats(snapshots);
            
            data = {
                totalCount: reduced.count,
                totalAmount: reduced.produced,
                byCategory: Object.entries(reduced.byCategory).map(([k, v]) => ({ k, v })),
                byMethod: Object.entries(reduced.byMethod).map(([k, v]) => ({ k, v })),
                byStatus: [
                    { k: 'paid', v: reduced.countPaid },
                    { k: 'partial', v: reduced.countPartial },
                    { k: 'pending', v: reduced.countPending }
                ]
            };
            
            // 🛡️ Fallback silencioso se snapshot vazio
            if (reduced.count === 0) {
                const v1 = await PaymentsView.aggregate([
                    { $match: { clinicId, paymentMonth: month, isDeleted: false } },
                    {
                        $group: {
                            _id: null,
                            totalCount: { $sum: 1 },
                            totalAmount: { $sum: '$amount' },
                            byCategory: { $push: { k: '$category', v: '$amount' } },
                            byMethod:   { $push: { k: '$method',   v: '$amount' } },
                            byStatus:   { $push: { k: '$status',   v: '$amount' } }
                        }
                    }
                ]);
                const v1Data = v1[0];
                if (v1Data) {
                    console.warn('[PaymentsV2] Snapshot vazio em stats/summary — fallback V1 ativado', { month, clinicId });
                    data = v1Data;
                }
            }
        } else {
            const stats = await PaymentsView.aggregate([
                { $match: { clinicId, paymentMonth: month, isDeleted: false } },
                {
                    $group: {
                        _id: null,
                        totalCount: { $sum: 1 },
                        totalAmount: { $sum: '$amount' },
                        byCategory: { $push: { k: '$category', v: '$amount' } },
                        byMethod:   { $push: { k: '$method',   v: '$amount' } },
                        byStatus:   { $push: { k: '$status',   v: '$amount' } }
                    }
                }
            ]);
            data = stats[0] || { totalCount: 0, totalAmount: 0, byCategory: [], byMethod: [], byStatus: [] };
        }
        
        res.json({
            success: true,
            month,
            source: USE_SNAPSHOT ? 'snapshot' : 'aggregate',
            data
        });
        
    } catch (error) {
        console.error('[PaymentsV2] Erro nas estatísticas:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

export default router;
