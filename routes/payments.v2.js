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
import mongoose from 'mongoose';
import { auth, authorize } from '../middleware/auth.js';
import PaymentsView from '../models/PaymentsView.js';
import Payment from '../models/Payment.js';
import Patient from '../models/Patient.js';
import { calculateCash, listParticularPendente } from '../services/unifiedFinancialService.v2.js';
import { CASH_NON_COUNTABLE_KINDS } from '../constants/financial.js';
import Session from '../models/Session.js';
import { rebuildPaymentsProjection } from '../projections/paymentsProjection.js';
import { getSnapshotsForRange, getSnapshotsForMonth, reducePaymentStats } from '../services/financialSnapshot.service.js';
import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';

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
            serviceType: p.serviceType,
            serviceLabel: p.serviceLabel,
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
        sendApiError(res, new AppError('PAYMENTS_QUERY_ERROR', error.message, { status: 500 }), req);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v2/payments/ledger — fonte da aba Financeiro › Pagamentos
//
// Lista os PAGAMENTOS de verdade (coleção Payment) do período, mais as sessões
// particulares realizadas e ainda sem pagamento ("a cobrar"), para que nada suma.
// Antes a aba listava agendamentos convertidos em "pagamento" e não mostrava venda
// de pacote, baixa de convênio, liminar nem quitação de dívida.
//
// Query: startDate, endDate (YYYY-MM-DD, horário de Brasília), situacao
// (todos|paid|partial|pending|canceled|a_cobrar), tipo (particular|pacote|convenio|liminar),
// forma (pix|cartao|dinheiro|transferencia|multi|outros), doctorId, q (nome do paciente),
// page, limit (máx. 100).
// Resposta: kpis (recebido = calculateCash, a mesma conta do Caixa), facets para os chips,
// items paginados e totalFiltrado.
// ─────────────────────────────────────────────────────────────────────────────
const LEDGER_TIPO_EXPR = {
    $switch: {
        branches: [
            { case: { $eq: [{ $toLower: { $ifNull: ['$billingType', ''] } }, 'liminar'] }, then: 'liminar' },
            { case: { $eq: [{ $toLower: { $ifNull: ['$paymentMethod', ''] } }, 'liminar_credit'] }, then: 'liminar' },
            { case: { $eq: [{ $toLower: { $ifNull: ['$billingType', ''] } }, 'convenio'] }, then: 'convenio' },
            { case: { $eq: [{ $toLower: { $ifNull: ['$paymentMethod', ''] } }, 'convenio'] }, then: 'convenio' }
        ],
        default: {
            $cond: {
                if: { $or: [
                    { $ifNull: ['$package', false] },
                    { $eq: [{ $toLower: { $ifNull: ['$serviceType', ''] } }, 'package_session'] },
                    { $eq: ['$kind', 'package_receipt'] }
                ] },
                then: 'pacote',
                else: 'particular'
            }
        }
    }
};
const LEDGER_FORMA_EXPR = {
    $let: {
        vars: { m: { $toLower: { $ifNull: ['$paymentMethod', ''] } } },
        in: {
            $switch: {
                branches: [
                    { case: { $gt: [{ $size: { $ifNull: ['$splitMethods', []] } }, 1] }, then: 'multi' },
                    { case: { $regexMatch: { input: '$$m', regex: /^pix$/ } }, then: 'pix' },
                    { case: { $regexMatch: { input: '$$m', regex: /cartao|card|credito|debito|credit|debit/ } }, then: 'cartao' },
                    { case: { $regexMatch: { input: '$$m', regex: /dinheiro|cash/ } }, then: 'dinheiro' },
                    { case: { $regexMatch: { input: '$$m', regex: /transfer|ted|doc/ } }, then: 'transferencia' }
                ],
                default: 'outros'
            }
        }
    }
};

function escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

router.get('/ledger', auth, authorize(['admin', 'secretary']), async (req, res) => {
    try {
        const {
            startDate, endDate,
            situacao = 'todos', tipo, forma, doctorId, q,
            page = 1, limit = 50
        } = req.query;

        const isDay = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
        const today = moment().tz(TIMEZONE).format('YYYY-MM-DD');
        const startStr = isDay(startDate) ? startDate : today;
        const endStr = isDay(endDate) ? endDate : startStr;
        const start = moment.tz(startStr, TIMEZONE).startOf('day').toDate();
        const end = moment.tz(endStr, TIMEZONE).endOf('day').toDate();

        const pageNum = Math.max(1, parseInt(page) || 1);
        const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 50));

        // Mesma janela de data e mesmas exclusões do caixa (calculateCash), sem filtrar status.
        const base = {
            amount: { $gt: 0 },
            kind: { $nin: CASH_NON_COUNTABLE_KINDS },
            $and: [
                { $or: [{ isFromPackage: { $ne: true } }, { kind: 'session_payment' }] },
                { $or: [
                    { financialDate: { $gte: start, $lte: end } },
                    { financialDate: { $exists: false }, paymentDate: { $gte: start, $lte: end } },
                    { financialDate: null, paymentDate: { $gte: start, $lte: end } }
                ] }
            ]
        };
        if (doctorId && mongoose.Types.ObjectId.isValid(doctorId)) {
            base.doctor = new mongoose.Types.ObjectId(doctorId);
        }
        let patientIds = null;
        if (q && String(q).trim().length >= 2) {
            const pats = await Patient.find({ fullName: { $regex: escapeRegex(String(q).trim()), $options: 'i' } })
                .select('_id').limit(500).lean();
            patientIds = pats.map(p => p._id);
            base.patient = { $in: patientIds };
        }

        const derive = [{ $addFields: { _tipo: LEDGER_TIPO_EXPR, _forma: LEDGER_FORMA_EXPR, _data: { $ifNull: ['$financialDate', '$paymentDate'] } } }];
        const chipFilter = {};
        if (tipo) chipFilter._tipo = tipo;
        if (forma) chipFilter._forma = forma;
        const statusFilter = ['paid', 'partial', 'pending', 'canceled', 'refunded'].includes(situacao) ? { status: situacao } : {};

        // "A cobrar" (sessões sem pagamento) — mesma regra do particularPendente da Produção.
        const pendentesPromise = listParticularPendente(start, end);
        const cashPromise = calculateCash(start, end, { includeDetails: false });

        const [facetRaw] = await Payment.aggregate([
            { $match: base },
            ...derive,
            { $facet: {
                status: [{ $match: chipFilter }, { $group: { _id: '$status', count: { $sum: 1 }, total: { $sum: '$amount' } } }],
                tipo: [{ $match: statusFilter }, ...(forma ? [{ $match: { _forma: forma } }] : []), { $group: { _id: '$_tipo', count: { $sum: 1 } } }],
                forma: [{ $match: statusFilter }, ...(tipo ? [{ $match: { _tipo: tipo } }] : []), { $group: { _id: '$_forma', count: { $sum: 1 } } }],
                filtrado: [{ $match: { ...statusFilter, ...chipFilter } }, { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$amount' } } }],
                items: situacao === 'a_cobrar' ? [{ $match: { _id: { $exists: false } } }] : [
                    { $match: { ...statusFilter, ...chipFilter } },
                    { $sort: { _data: -1, createdAt: -1 } },
                    { $skip: (pageNum - 1) * limitNum },
                    { $limit: limitNum }
                ]
            } }
        ]);

        let pendentes = await pendentesPromise;
        if (doctorId) pendentes = pendentes.filter(p => String(p.doctor?._id || '') === String(doctorId));
        if (patientIds) {
            const set = new Set(patientIds.map(String));
            pendentes = pendentes.filter(p => set.has(String(p.patient?._id || '')));
        }
        const cash = await cashPromise;

        const byStatus = Object.fromEntries((facetRaw.status || []).map(r => [r._id, r]));
        const pick = (k) => ({ count: byStatus[k]?.count || 0, total: Number((byStatus[k]?.total || 0).toFixed(2)) });
        const aCobrarTotal = pendentes.reduce((s, p) => s + (p.sessionValue || 0), 0);

        let items;
        let pagination;
        let totalFiltrado;
        if (situacao === 'a_cobrar') {
            const slice = pendentes.slice((pageNum - 1) * limitNum, pageNum * limitNum);
            items = slice.map(p => ({
                _id: `sessao_${p._id}`,
                kind: 'a_cobrar',
                sessionId: p._id,
                appointmentId: p.appointmentId,
                data: p.apptDate || p.date,
                hora: p.apptTime || p.time || null,
                patient: p.patient,
                doctor: p.doctor,
                amount: p.sessionValue || 0,
                status: 'a_cobrar',
                tipo: p.isPackage ? 'pacote' : 'particular',
                forma: null,
                serviceType: p.serviceType || null
            }));
            pagination = { page: pageNum, limit: limitNum, total: pendentes.length, pages: Math.ceil(pendentes.length / limitNum) };
            totalFiltrado = Number(aCobrarTotal.toFixed(2));
        } else {
            const raw = facetRaw.items || [];
            await Payment.populate(raw, [
                { path: 'patient', select: 'fullName phone' },
                { path: 'doctor', select: 'fullName specialty' },
                { path: 'appointment', select: 'date time operationalStatus serviceType' },
                { path: 'package', select: 'totalSessions sessionsDone specialty' }
            ]);
            items = raw.map(p => ({
                _id: p._id,
                kind: 'payment',
                paymentKind: p.kind || null,
                data: p._data,
                patient: p.patient ? { _id: p.patient._id, fullName: p.patient.fullName, phone: p.patient.phone } : null,
                doctor: p.doctor ? { _id: p.doctor._id, fullName: p.doctor.fullName } : null,
                amount: p.amount,
                status: p.status,
                tipo: p._tipo,
                forma: p._forma,
                paymentMethod: p.paymentMethod || null,
                splitMethods: (p.splitMethods || []).map(m => ({ method: m.method, amount: m.amount })),
                serviceType: p.serviceType || p.appointment?.serviceType || null,
                appointment: p.appointment ? {
                    _id: p.appointment._id, date: p.appointment.date, time: p.appointment.time,
                    operationalStatus: p.appointment.operationalStatus
                } : null,
                package: p.package ? { _id: p.package._id, totalSessions: p.package.totalSessions, sessionsDone: p.package.sessionsDone } : null,
                notes: p.notes || null
            }));
            const f = facetRaw.filtrado?.[0] || { count: 0, total: 0 };
            pagination = { page: pageNum, limit: limitNum, total: f.count, pages: Math.ceil(f.count / limitNum) };
            totalFiltrado = Number((f.total || 0).toFixed(2));
        }

        const countMap = (arr) => Object.fromEntries((arr || []).map(r => [r._id, r.count]));
        const statusCounts = {
            todos: (facetRaw.status || []).reduce((s, r) => s + r.count, 0),
            paid: pick('paid').count,
            partial: pick('partial').count,
            pending: pick('pending').count,
            canceled: pick('canceled').count + pick('refunded').count,
            a_cobrar: pendentes.length
        };

        res.json({
            success: true,
            period: { startDate: startStr, endDate: endStr },
            kpis: {
                // Recebido = a mesma conta do Caixa (calculateCash), para os dois nunca divergirem.
                recebido: { total: Number((cash.total || 0).toFixed(2)), count: cash.count || 0 },
                aCobrar: { total: Number(aCobrarTotal.toFixed(2)), count: pendentes.length },
                parcial: pick('partial'),
                cancelado: { count: pick('canceled').count + pick('refunded').count, total: Number((pick('canceled').total + pick('refunded').total).toFixed(2)) }
            },
            facets: { status: statusCounts, tipo: countMap(facetRaw.tipo), forma: countMap(facetRaw.forma) },
            items,
            pagination,
            totalFiltrado
        });
    } catch (error) {
        console.error('[PaymentsV2] ledger erro:', error);
        sendApiError(res, new AppError('PAYMENTS_LEDGER_ERROR', error.message, { status: 500 }), req);
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
            return sendApiError(res, new AppError('NOT_FOUND', 'Pagamento não encontrado', { status: 404 }), req);
        }
        
        res.json({
            success: true,
            data: payment
        });
        
    } catch (error) {
        console.error('[PaymentsV2] Erro ao buscar pagamento:', error);
        sendApiError(res, error, req);
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
            return sendApiError(res, new AppError('FORBIDDEN', 'Acesso negado', { status: 403 }), req);
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
        sendApiError(res, error, req);
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
        sendApiError(res, error, req);
    }
});

/**
 * GET /api/v2/payments/future-sessions/:patientId
 * Retorna sessões avulsas agendadas (antecipadas) de um paciente
 */
router.get('/future-sessions/:patientId', auth, async (req, res) => {
    try {
        let { patientId } = req.params;

        // Verifica se é um ID de view ou ID real
        const PatientsView = mongoose.model('PatientsView');
        const patientView = await PatientsView.findById(patientId).lean();

        if (patientView) {
            console.log(`[future-sessions] PatientId é de view, usando patientId real: ${patientView.patientId}`);
            patientId = patientView.patientId;
        }

        const sessions = await Session.find({
            patient: patientId,
            isAdvance: true,
            status: 'scheduled'
        })
            .populate('doctor', 'fullName specialty')
            .select('date time sessionType specialty')
            .sort({ date: 1 });

        res.json(sessions);
    } catch (error) {
        console.error('[PaymentsV2] Erro ao buscar future-sessions:', error);
        sendApiError(res, error, req);
    }
});

export default router;
