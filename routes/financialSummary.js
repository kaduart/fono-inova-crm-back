/**
 * 💰 FINANCIAL SUMMARY — Fonte de verdade financeira por paciente
 *
 * Princípio: Package é legado. A verdade financeira vive em Payment.
 * Este endpoint retorna:
 *   - totalPaid     → SUM(Payment.amount WHERE status='paid')
 *   - totalPending  → SUM(Payment.amount WHERE status='pending')
 *   - totalSessions → COUNT(Appointment WHERE operationalStatus='completed')
 *
 * Não usa Package.balance, Package.totalPaid, nem PatientBalance.
 */

import { Router } from 'express';
import mongoose from 'mongoose';
import Payment from '../models/Payment.js';
import Appointment from '../models/Appointment.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();

/**
 * GET /api/v2/financial/patient/:patientId/summary
 *
 * Retorna resumo financeiro REAL do paciente baseado em Payment records.
 */
router.get('/patient/:patientId/summary', asyncHandler(async (req, res) => {
    const { patientId } = req.params;
    const { packageId } = req.query; // opcional: filtrar por package específico

    const patientOid = mongoose.Types.ObjectId.isValid(patientId)
        ? new mongoose.Types.ObjectId(patientId)
        : patientId;

    // 🔧 Payment armazena patient como ObjectId OU string
    const patientMatch = {
        $or: [
            { patient: patientOid },
            { patient: patientId },
            { patientId: patientId }
        ]
    };
    // 🚫 package_consumed representa consumo de crédito, não dinheiro recebido
    const match = { ...patientMatch, kind: { $ne: 'package_consumed' } };
    if (packageId) {
        // Package pode ser null em appointments avulsos — filtramos pelo appointment
        // 🔧 TAMBÉM incluímos payments ligados diretamente ao package (ex: package_receipt com appointment:null)
        const packageOid = mongoose.Types.ObjectId.isValid(packageId)
            ? new mongoose.Types.ObjectId(packageId)
            : packageId;
        const appointmentIds = await Appointment.find({
            $or: [{ patient: patientOid }, { patient: patientId }],
            package: packageOid
        }).distinct('_id');
        match.$and = [
            { $or: patientMatch.$or },
            {
                $or: [
                    { appointment: { $in: appointmentIds } },
                    { package: packageOid },
                    { package: packageId }
                ]
            }
        ];
        delete match.$or; // evita conflito com o spread anterior
    }

    const paidAgg = await Payment.aggregate([
        { $match: { ...match, status: 'paid' } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]);

    const pendingAgg = await Payment.aggregate([
        { $match: { ...match, status: 'pending', billingType: { $nin: ['convenio', 'liminar'] } } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]);

    // 🆕 SSOT: Breakdown por billingType para evitar inflar particular com liminar
    const particularPaidAgg = await Payment.aggregate([
        { $match: { ...match, status: 'paid', billingType: 'particular' } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]);

    const liminarPaidAgg = await Payment.aggregate([
        { $match: { ...match, status: 'paid', billingType: 'liminar' } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]);

    const convenioPaidAgg = await Payment.aggregate([
        { $match: { ...match, status: 'paid', billingType: 'convenio' } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]);

    const completedSessions = await Appointment.countDocuments({
        patient: patientId,
        operationalStatus: 'completed',
        ...(packageId ? { package: packageId } : {})
    });

    res.json({
        success: true,
        data: {
            patientId,
            packageId: packageId || null,
            // Totais globais (todos os billingTypes)
            totalPaid: paidAgg[0]?.total || 0,
            paidCount: paidAgg[0]?.count || 0,
            totalPending: pendingAgg[0]?.total || 0,
            pendingCount: pendingAgg[0]?.count || 0,
            completedSessions,
            // 🔴 OPERACIONAL: dívida real das sessões já feitas
            sessionDebt: (pendingAgg[0]?.total || 0),
            // 🆕 Breakdown por billingType (SSOT)
            particularPaid: particularPaidAgg[0]?.total || 0,
            particularCount: particularPaidAgg[0]?.count || 0,
            liminarPaid: liminarPaidAgg[0]?.total || 0,
            liminarCount: liminarPaidAgg[0]?.count || 0,
            convenioPaid: convenioPaidAgg[0]?.total || 0,
            convenioCount: convenioPaidAgg[0]?.count || 0
        }
    });
}));

/**
 * GET /api/v2/financial/patient/:patientId/pending-payments
 *
 * Lista todos os Payment pending do paciente (fonte de verdade para fiado).
 */
router.get('/patient/:patientId/pending-payments', asyncHandler(async (req, res) => {
    const { patientId } = req.params;

    const patientOid = mongoose.Types.ObjectId.isValid(patientId)
        ? new mongoose.Types.ObjectId(patientId)
        : patientId;

    const pendingPayments = await Payment.find({
        $or: [{ patient: patientOid }, { patient: patientId }, { patientId: patientId }],
        status: 'pending'
    })
    .sort({ createdAt: -1 })
    .populate('appointment', 'date time sessionValue')
    .lean();

    res.json({
        success: true,
        data: pendingPayments.map(p => ({
            id: p._id.toString(),
            amount: p.amount,
            status: p.status,
            createdAt: p.createdAt,
            appointment: p.appointment ? {
                id: p.appointment._id?.toString(),
                date: p.appointment.date,
                time: p.appointment.time,
                sessionValue: p.appointment.sessionValue
            } : null,
            description: p.description || null
        })),
        meta: {
            totalPending: pendingPayments.reduce((s, p) => s + (p.amount || 0), 0),
            count: pendingPayments.length
        }
    });
}));

/**
 * GET /api/v2/financial/patient/:patientId/paid-payments
 *
 * Lista todos os Payment paid do paciente (fonte de verdade para recebidos).
 */
router.get('/patient/:patientId/paid-payments', asyncHandler(async (req, res) => {
    const { patientId } = req.params;

    const patientOid = mongoose.Types.ObjectId.isValid(patientId)
        ? new mongoose.Types.ObjectId(patientId)
        : patientId;

    const paidPayments = await Payment.find({
        $or: [{ patient: patientOid }, { patient: patientId }, { patientId: patientId }],
        status: 'paid'
    })
    .sort({ financialDate: -1, paidAt: -1 })
    .populate('appointment', 'date time sessionValue')
    .lean();

    res.json({
        success: true,
        data: paidPayments.map(p => ({
            id: p._id.toString(),
            amount: p.amount,
            status: p.status,
            paidAt: p.paidAt,
            financialDate: p.financialDate,
            createdAt: p.createdAt,
            paymentMethod: p.paymentMethod,
            appointment: p.appointment ? {
                id: p.appointment._id?.toString(),
                date: p.appointment.date,
                time: p.appointment.time,
                sessionValue: p.appointment.sessionValue
            } : null,
            description: p.description || null
        })),
        meta: {
            totalPaid: paidPayments.reduce((s, p) => s + (p.amount || 0), 0),
            count: paidPayments.length
        }
    });
}));

/**
 * ⚠️ NOVA FEATURE — NÃO ATIVAR AGORA
 *
 * Debt aging analysis separado por natureza (particular vs convenio).
 * Desativado intencionalmente enquanto o sistema está em fase de
 * consolidação e remoção de legado.
 *
 * TODO: ativar após estabilização completa do SSOT.
 */
/*
router.get('/aging', asyncHandler(async (req, res) => {
    const now = new Date();

    // ═══════════════════════════════════════════════════════════
    // PARTICULAR — Dívida real (status='pending', não é convenio)
    // ═══════════════════════════════════════════════════════════
    const particularBuckets = await Payment.aggregate([
        {
            $match: {
                status: 'pending',
                billingType: { $nin: ['convenio'] }
            }
        },
        {
            $addFields: {
                daysPending: {
                    $floor: {
                        $divide: [
                            { $subtract: [now, { $ifNull: ['$createdAt', '$paymentDate', now] }] },
                            1000 * 60 * 60 * 24
                        ]
                    }
                }
            }
        },
        {
            $group: {
                _id: {
                    $switch: {
                        branches: [
                            { case: { $lte: ['$daysPending', 30] }, then: '0-30' },
                            { case: { $lte: ['$daysPending', 60] }, then: '31-60' },
                            { case: { $lte: ['$daysPending', 90] }, then: '61-90' }
                        ],
                        default: '90+'
                    }
                },
                total: { $sum: '$amount' },
                count: { $sum: 1 }
            }
        },
        { $sort: { _id: 1 } }
    ]);

    // ═══════════════════════════════════════════════════════════
    // CONVÊNIO — A receber (billed, aguardando pagamento)
    // ═══════════════════════════════════════════════════════════
    const convenioBuckets = await Payment.aggregate([
        {
            $match: {
                billingType: 'convenio',
                'insurance.status': 'billed'
            }
        },
        {
            $addFields: {
                daysBilled: {
                    $floor: {
                        $divide: [
                            { $subtract: [now, { $ifNull: ['$insurance.billedAt', '$createdAt', now] }] },
                            1000 * 60 * 60 * 24
                        ]
                    }
                }
            }
        },
        {
            $group: {
                _id: {
                    $switch: {
                        branches: [
                            { case: { $lte: ['$daysBilled', 30] }, then: '0-30' },
                            { case: { $lte: ['$daysBilled', 60] }, then: '31-60' },
                            { case: { $lte: ['$daysBilled', 90] }, then: '61-90' }
                        ],
                        default: '90+'
                    }
                },
                total: { $sum: '$insurance.grossAmount' },
                count: { $sum: 1 }
            }
        },
        { $sort: { _id: 1 } }
    ]);

    // Helper para normalizar buckets (garante que todas as faixas existem)
    const normalize = (buckets, ranges) => {
        const map = Object.fromEntries(buckets.map(b => [b._id, { total: b.total, count: b.count }]));
        return ranges.map(range => ({
            range,
            total: map[range]?.total || 0,
            count: map[range]?.count || 0
        }));
    };

    const ranges = ['0-30', '31-60', '61-90', '90+'];
    const particular = normalize(particularBuckets, ranges);
    const convenio = normalize(convenioBuckets, ranges);

    res.json({
        success: true,
        data: {
            particular: {
                buckets: particular,
                total: particular.reduce((s, b) => s + b.total, 0),
                totalCount: particular.reduce((s, b) => s + b.count, 0)
            },
            convenio: {
                buckets: convenio,
                total: convenio.reduce((s, b) => s + b.total, 0),
                totalCount: convenio.reduce((s, b) => s + b.count, 0)
            },
            generatedAt: now.toISOString()
        }
    });
}));
*/

export default router;
