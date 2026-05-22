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
import Package from '../models/Package.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();

/**
 * 🆕 Calcula a dívida REAL de pacotes per-session:
 *    max(0, completedAppointments * sessionValue - realPaid)
 *
 * Usa Appointment.completed como base (só cobra sessões JÁ FEITAS).
 * Soma Payment.paid vinculados aos appointments do pacote.
 */
async function calculateRealPackageDebt(patientId, packageId = null) {
    const patientOid = mongoose.Types.ObjectId.isValid(patientId)
        ? new mongoose.Types.ObjectId(patientId)
        : patientId;

    const packageMatch = {
        patient: patientOid,
        model: 'per_session',
    };
    if (packageId) {
        packageMatch._id = mongoose.Types.ObjectId.isValid(packageId)
            ? new mongoose.Types.ObjectId(packageId)
            : packageId;
    }

    const packages = await Package.find(packageMatch).lean();
    if (packages.length === 0) return { totalDebt: 0, items: [] };

    // Busca appointments completed em batch
    const packageIds = packages.map(p => p._id);
    const completedAgg = await Appointment.aggregate([
        { $match: { package: { $in: packageIds }, operationalStatus: 'completed' } },
        { $group: { _id: '$package', count: { $sum: 1 } } }
    ]);
    const completedMap = Object.fromEntries(
        completedAgg.map(c => [c._id.toString(), c.count])
    );

    // Busca appointments de cada pacote para linkar com payments
    const allAppointments = await Appointment.find({
        package: { $in: packageIds }
    }).select('_id package').lean();
    const apptsByPackage = {};
    for (const a of allAppointments) {
        const pid = a.package.toString();
        if (!apptsByPackage[pid]) apptsByPackage[pid] = [];
        apptsByPackage[pid].push(a._id.toString());
    }

    // Busca todos os payments paid vinculados a esses appointments
    const allApptIds = allAppointments.map(a => a._id);
    const paidAgg = await Payment.aggregate([
        {
            $match: {
                patient: { $in: [patientOid, patientId] },
                status: 'paid',
                appointment: { $in: allApptIds }
            }
        },
        { $group: { _id: '$appointment', total: { $sum: '$amount' } } }
    ]);
    const paidByAppt = Object.fromEntries(
        paidAgg.map(p => [p._id.toString(), p.total])
    );

    let totalDebt = 0;
    const items = [];

    for (const pkg of packages) {
        const pid = pkg._id.toString();
        const completed = completedMap[pid] || 0;
        const sessionValue = pkg.sessionValue || 0;
        const completedValue = completed * sessionValue;

        const apptIds = apptsByPackage[pid] || [];
        const realPaid = apptIds.reduce((sum, aid) => sum + (paidByAppt[aid] || 0), 0);

        const debt = Math.max(0, completedValue - realPaid);
        if (debt > 0.01) {
            totalDebt += debt;
            items.push({
                packageId: pid,
                specialty: pkg.specialty || pkg.sessionType || 'terapia',
                debt,
                completed,
                sessionValue,
                realPaid,
                completedValue
            });
        }
    }

    return { totalDebt, items };
}

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

    // 🔥 packageOid precisa estar no escopo da função inteira (usado depois no try/catch)
    const packageOid = packageId && mongoose.Types.ObjectId.isValid(packageId)
        ? new mongoose.Types.ObjectId(packageId)
        : packageId;

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

    // 🆕 PACOTE PER-SESSION: dívida REAL (apenas sessões já feitas)
    let packageDebt = 0;
    let pendingAvulso = 0;
    try {
        const realPackageDebt = await calculateRealPackageDebt(patientId, packageId);
        packageDebt = realPackageDebt.totalDebt;

        // Dívida avulsa: payments pending que NÃO estão vinculados a appointments de pacote
        // 🔥 Se packageId foi passado, considera apenas appointments DAQUELE pacote como "de pacote"
        const appointmentsWithPackage = packageId
            ? await Appointment.find({
                patient: patientId,
                package: packageOid
            }).distinct('_id')
            : await Appointment.find({
                patient: patientId,
                package: { $exists: true, $ne: null }
            }).distinct('_id');

        const pendingAvulsoAgg = await Payment.aggregate([
            {
                $match: {
                    ...match,
                    status: 'pending',
                    billingType: { $nin: ['convenio', 'liminar'] },
                    appointment: { $nin: appointmentsWithPackage }
                }
            },
            { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
        ]);
        pendingAvulso = pendingAvulsoAgg[0]?.total || 0;
    } catch (calcErr) {
        console.error(`[financialSummary] Erro ao calcular packageDebt/pendingAvulso para patient ${patientId}:`, calcErr.message);
        // Fallback: usa o totalPending bruto (comportamento antigo)
        pendingAvulso = pendingAgg[0]?.total || 0;
        packageDebt = 0;
    }

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

    // 🔥 CORREÇÃO PER-SESSION: quando filtrado por packageId, calcular com sessões completadas
    let totalPaid = paidAgg[0]?.total || 0;
    let paidCount = paidAgg[0]?.count || 0;
    let particularPaid = particularPaidAgg[0]?.total || 0;
    let particularCount = particularPaidAgg[0]?.count || 0;
    let totalPending = pendingAgg[0]?.total || 0;
    let pendingCount = pendingAgg[0]?.count || 0;

    if (packageId) {
        try {
            const realDebt = await calculateRealPackageDebt(patientId, packageId);
            const pkg = await Package.findById(packageOid).lean();
            if (pkg && pkg.model === 'per_session') {
                // totalPaid = soma real dos payments paid do pacote (não Package.totalPaid que pode estar inflado)
                const appts = await Appointment.find({ package: packageOid }).select('_id').lean();
                const apptIds = appts.map(a => a._id);
                const paidForPkg = await Payment.aggregate([
                    { $match: { patient: { $in: [patientOid, patientId] }, status: 'paid', appointment: { $in: apptIds } } },
                    { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
                ]);
                totalPaid = paidForPkg[0]?.total || 0;
                paidCount = paidForPkg[0]?.count || 0;
                particularPaid = totalPaid;
                particularCount = paidCount;
                totalPending = realDebt.totalDebt;
                pendingCount = realDebt.items[0]?.completed || 0;
            }
        } catch (pkgErr) {
            console.error(`[financialSummary] Erro ao buscar Package ${packageId} para correção per-session:`, pkgErr.message);
        }
    }

    res.json({
        success: true,
        data: {
            patientId,
            packageId: packageId || null,
            // Totais globais (todos os billingTypes)
            totalPaid,
            paidCount,
            totalPending,
            pendingCount,
            completedSessions,
            // 🔴 OPERACIONAL: dívida real das sessões já feitas
            // Soma dívida avulsa + dívida de pacotes per-session (sessões completadas - pagas)
            sessionDebt: pendingAvulso + packageDebt,
            // 🆕 Breakdown por billingType (SSOT)
            particularPaid,
            particularCount,
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
 * Lista todos os débitos pendentes do paciente:
 * - Payments avulsos (não vinculados a pacotes per-session)
 * - Dívidas de pacotes per-session (Package.balance)
 *
 * NÃO inclui Payments pending vinculados a appointments de pacotes per-session,
 * pois a dívida real dessas sessões já está representada no Package.balance.
 */
router.get('/patient/:patientId/pending-payments', asyncHandler(async (req, res) => {
    const { patientId } = req.params;

    const patientOid = mongoose.Types.ObjectId.isValid(patientId)
        ? new mongoose.Types.ObjectId(patientId)
        : patientId;

    // Fonte de verdade: Payment records pending.
    // Débito só existe se a sessão foi completada (provisioning cria payment pending no complete).
    // Inclui sessions de pacotes — NÃO usa calculateRealPackageDebt.
    const pendingPayments = await Payment.find({
        $and: [
            { $or: [{ patient: patientOid }, { patient: patientId }, { patientId: patientId }] },
            { status: 'pending' },
            { kind: { $ne: 'package_consumed' } },
            { billingType: { $nin: ['convenio', 'liminar'] } }
        ]
    })
    .sort({ createdAt: -1 })
    .populate('appointment', 'date time specialty sessionValue package')
    .lean();

    const items = pendingPayments.map(p => {
        const appt = p.appointment;
        const specialty = appt?.specialty || p.specialty || null;
        const packageId = appt?.package?.toString() || p.package?.toString() || null;

        return {
            id: p._id.toString(),
            source: 'payment',
            amount: p.amount,
            status: p.status,
            createdAt: p.createdAt,
            paidAt: p.paidAt || null,
            description: p.description || null,
            appointment: appt ? {
                id: appt._id?.toString(),
                date: appt.date,
                time: appt.time,
                sessionValue: appt.sessionValue
            } : null,
            packageId,
            packageName: packageId ? `Pacote ${specialty || ''}`.trim() : null,
            specialty
        };
    });

    res.json({
        success: true,
        data: items,
        meta: {
            totalPending: items.reduce((s, p) => s + (p.amount || 0), 0),
            count: items.length
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
