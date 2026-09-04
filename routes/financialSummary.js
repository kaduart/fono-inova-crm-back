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
import { LEGACY_FINANCIAL_VIEW_EXCLUDED_KINDS, PAYMENT_KIND } from '../constants/financial.js';

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

    // Busca payments 'paid' E 'canceled' vinculados a esses appointments — uma sessão
    // com pagamento cancelado (baixa/estorno administrativo, ex: write-off de dívida
    // indevida) já está resolvida e não deve voltar a contar como dívida em aberto.
    // Bug real encontrado 2026-08-26: só reconhecer 'paid' fazia sessões com Payment
    // cancelado serem recontadas como dívida "fantasma" (ex: Henre Gabriel Jacinto Da
    // Silva, R$1440 de dívida inexistente — todas as sessões já tinham Payment
    // cancelado, não pending).
    const allApptIds = allAppointments.map(a => a._id);
    const resolvedAgg = await Payment.aggregate([
        {
            $match: {
                patient: { $in: [patientOid, patientId] },
                status: { $in: ['paid', 'canceled'] },
                appointment: { $in: allApptIds }
            }
        },
        { $group: { _id: '$appointment', total: { $sum: '$amount' }, status: { $first: '$status' } } }
    ]);
    // Só o valor de payments 'paid' conta como dinheiro recebido (realPaid);
    // 'canceled' entra em resolvedByAppt (abate da sessão) mas não em realPaid.
    const paidByAppt = Object.fromEntries(
        resolvedAgg.filter(p => p.status === 'paid').map(p => [p._id.toString(), p.total])
    );
    const resolvedByAppt = Object.fromEntries(
        resolvedAgg.map(p => [p._id.toString(), p.total])
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
        const resolvedTotal = apptIds.reduce((sum, aid) => sum + (resolvedByAppt[aid] || 0), 0);

        const debt = Math.max(0, completedValue - resolvedTotal);
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
 * Calcula o resumo financeiro de um paciente (opcionalmente escopado a 1 pacote).
 * Extraído do handler de GET /summary pra ser reutilizável pelo endpoint em lote
 * (POST /summary/batch) sem duplicar nenhuma regra de cálculo — mesma função,
 * mesmo resultado, só chamada N vezes em paralelo no backend em vez de N vezes
 * via HTTP pelo frontend.
 */
async function buildPatientFinancialSummary(patientId, packageId) {
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
    // 🚫 exclui kinds que representam consumo/recibo agregado, não dinheiro novo
    // recebido (ver constants/financial.js LEGACY_FINANCIAL_VIEW_EXCLUDED_KINDS — bug de dupla
    // contagem confirmado em produção 2026-07-07 com monthly_settlement).
    const match = { ...patientMatch, kind: { $nin: LEGACY_FINANCIAL_VIEW_EXCLUDED_KINDS } };
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

        // 🔧 FIX (2026-09-03): só conta como dívida real se a sessão vinculada já foi
        // completada — um agendamento futuro/em andamento ainda não é dívida, é "a
        // receber" (mesmo princípio já aplicado em GET /pending-payments, linha ~394).
        // Achado real: paciente com uma única avaliação ainda não finalizada aparecia
        // com "Saldo em aberto" ao tentar completar a PRÓPRIA sessão (Payment pending
        // criado junto com o agendamento, appointment.clinicalStatus ainda 'pending').
        const incompleteAppointmentIds = await Appointment.find({
            patient: patientId,
            clinicalStatus: { $ne: 'completed' }
        }).distinct('_id');

        const pendingAvulsoAgg = await Payment.aggregate([
            {
                $match: {
                    ...match,
                    status: 'pending',
                    billingType: { $nin: ['convenio', 'liminar'] },
                    appointment: { $nin: [...appointmentsWithPackage, ...incompleteAppointmentIds] }
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
    //
    // 🚨 FIX LOCAL (2026-07-10): NÃO reusar `match.kind` (LEGACY_FINANCIAL_VIEW_EXCLUDED_KINDS) aqui.
    // Essa constante exclui `package_receipt` pensando no modelo LIMINAR, onde a venda
    // (package_receipt) e o reconhecimento de receita por sessão (revenue_recognition)
    // são dois eventos financeiros independentes — somar os dois duplicaria.
    // Só que pra pacote PARTICULAR prepaid/per_session, `package_receipt` É o único
    // registro do dinheiro recebido (ver back/docs/finance-integrity-audit/
    // classification-rules.md, categoria PREPAID) — excluí-lo zera o "Pago" de todo
    // pacote particular pré-pago. Como esta query já filtra billingType:'particular'
    // (nunca 'liminar'), é seguro reincluir package_receipt aqui, sem tocar na constante
    // global nem afetar paymentSync.service.js ou os demais totais deste endpoint.
    const particularPaidAgg = await Payment.aggregate([
        {
            $match: {
                ...match,
                kind: { $nin: [PAYMENT_KIND.PACKAGE_CONSUMED, PAYMENT_KIND.MONTHLY_SETTLEMENT, PAYMENT_KIND.DEBT_SETTLEMENT] },
                status: 'paid',
                billingType: 'particular'
            }
        },
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

    return {
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
    };
}

/**
 * GET /api/v2/financial/patient/:patientId/summary
 *
 * Retorna resumo financeiro REAL do paciente baseado em Payment records.
 */
router.get('/patient/:patientId/summary', asyncHandler(async (req, res) => {
    const { patientId } = req.params;
    const { packageId } = req.query; // opcional: filtrar por package específico

    const data = await buildPatientFinancialSummary(patientId, packageId);

    res.json({ success: true, data });
}));

/**
 * GET /api/v2/financial/patient/:patientId/summary/batch?packageIds=a,b,c
 *
 * Mesma coisa que /summary, mas para vários pacotes de uma vez — 1 round-trip
 * HTTP em vez de N. Achado real (2026-09-01): tela de pacotes de um paciente com
 * 11 pacotes inativos disparava 11 chamadas a /summary, cada uma com ~8-10
 * aggregations no Mongo, serializadas pelo limite de conexões do navegador
 * (até 2s pra carregar a aba). Roda exatamente a mesma função de cálculo do
 * endpoint singular, só que em paralelo no backend (Promise.all) — nenhuma
 * regra financeira nova, nenhum resultado diferente por pacote.
 *
 * Resposta: { success, data: { [packageId]: <mesmo shape de /summary> } }
 * Um packageId que falhar no cálculo não derruba os demais — vem com `error`
 * no lugar do resumo, pro frontend decidir como tratar (achado real: um
 * pacote com dado inconsistente não deve travar o carregamento dos outros 10).
 */
router.get('/patient/:patientId/summary/batch', asyncHandler(async (req, res) => {
    const { patientId } = req.params;
    const { packageIds } = req.query;

    if (!packageIds || typeof packageIds !== 'string') {
        return res.status(400).json({ success: false, message: 'packageIds é obrigatório (lista separada por vírgula)' });
    }

    const ids = [...new Set(packageIds.split(',').map(id => id.trim()).filter(Boolean))];
    if (ids.length === 0) {
        return res.status(400).json({ success: false, message: 'packageIds não pode ser vazio' });
    }

    const results = await Promise.all(
        ids.map(async (packageId) => {
            try {
                const summary = await buildPatientFinancialSummary(patientId, packageId);
                return [packageId, summary];
            } catch (err) {
                console.error(`[financialSummary] Erro no batch para package ${packageId}:`, err.message);
                return [packageId, { error: err.message }];
            }
        })
    );

    res.json({ success: true, data: Object.fromEntries(results) });
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
    // ✅ CORREÇÃO: débito só existe se a sessão foi completada.
    // Agendamentos futuros são "a receber", não dívida real do paciente.
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
    .populate('appointment', 'date time specialty sessionValue package operationalStatus')
    .lean();

    // Filtra: mantém apenas payments sem agendamento (débito manual) ou com sessão completada.
    // 🚨 FIX (2026-09-04): usava appointment.clinicalStatus, mas a fonte da
    // verdade pra "a sessão aconteceu" é operationalStatus (documentado em
    // models/Appointment.js: "NUNCA use clinicalStatus para decidir se uma
    // sessão foi realizada. Sempre verifique operationalStatus === 'completed'").
    // clinicalStatus rastreia documentação/prontuário, que pode ficar em aberto
    // muito depois da sessão já ter acontecido e sido paga/pendente de
    // pagamento — achado real: Mikhael Venâncio da cunha tinha uma sessão com
    // operationalStatus='completed' e clinicalStatus='pending', então a dívida
    // real de R$180 sumia desta lista mas continuava aparecendo no resumo
    // legado do cabeçalho do paciente (PatientBalanceHeader), gerando
    // divergência entre as duas telas do mesmo paciente.
    const realDebtPayments = pendingPayments.filter(p =>
        !p.appointment || p.appointment.operationalStatus === 'completed'
    );

    const items = realDebtPayments.map(p => {
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
            count: items.length,
            totalReceivable: pendingPayments.reduce((s, p) => s + (p.amount || 0), 0),
            receivableCount: pendingPayments.length
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
        status: 'paid',
        kind: { $nin: LEGACY_FINANCIAL_VIEW_EXCLUDED_KINDS }
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
            splitMethods: p.splitMethods,
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
