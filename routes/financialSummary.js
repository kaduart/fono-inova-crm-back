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
import moment from 'moment-timezone';
import Payment from '../models/Payment.js';
import Appointment from '../models/Appointment.js';
import Package from '../models/Package.js';
import Session from '../models/Session.js';
import PatientBalance from '../models/PatientBalance.js';
import { getPatientPendingSnapshot } from '../services/patientPendingSnapshot.js';
import { reconcilePackagesForPayments } from '../services/packagePaymentReconciliation.js';
import { auth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { LEGACY_FINANCIAL_VIEW_EXCLUDED_KINDS, PAYMENT_KIND } from '../constants/financial.js';
import { EventTypes } from '../infrastructure/events/eventPublisher.js';
import { saveToOutbox } from '../infrastructure/outbox/outboxPattern.js';
import { syncAffectedViews } from '../services/projections/syncAffectedViews.js';
import { clearCashflowCacheForDates } from './cashflow.v2.js';
import { safeAbortTransaction } from '../utils/safeAbortTransaction.js';
import logger from '../utils/logger.js';
import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';

const router = Router();

// ============================================
// HELPERS de método de pagamento — mesmo padrão de payment.v2.js (bulk-settle)
// ============================================
const VALID_PAYMENT_METHODS = ['dinheiro', 'pix', 'credit_card', 'debit_card', 'cartao', 'cartão', 'cartao_credito', 'cartao_debito', 'transferencia', 'transferência', 'transferencia_bancaria', 'cash', 'bank_transfer'];

const normalizePaymentMethod = (method) => {
    const methodMap = {
        'dinheiro': 'cash',
        'pix': 'pix',
        'credit_card': 'credit_card',
        'debit_card': 'debit_card',
        'cartao': 'credit_card',
        'cartão': 'credit_card',
        'cartao_credito': 'credit_card',
        'cartao_debito': 'debit_card',
        'transferencia': 'bank_transfer',
        'transferência': 'bank_transfer',
        'transferencia_bancaria': 'bank_transfer',
        'cash': 'cash',
        'bank_transfer': 'bank_transfer'
    };
    return methodMap[method] || 'cash';
};

// Mapeia método do Payment (cash/credit_card/bank_transfer) de volta para o enum do Appointment
const mapPaymentMethodToAppointment = (method) => {
    const map = {
        'cash': 'dinheiro',
        'dinheiro': 'dinheiro',
        'pix': 'pix',
        'credit_card': 'cartao_credito',
        'cartao': 'cartao_credito',
        'cartão': 'cartao_credito',
        'debit_card': 'cartao_debito',
        'bank_transfer': 'transferencia_bancaria',
        'transferencia': 'transferencia_bancaria',
        'transferência': 'transferencia_bancaria'
    };
    return map[method] || method;
};

const toCents = value => Math.round(Number(value) * 100);
const fromCents = value => value / 100;

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
        return sendApiError(
          res,
          new AppError('BAD_REQUEST', 'packageIds é obrigatório (lista separada por vírgula)', {
            status: 400,
          }),
          req
        );
    }

    const ids = [...new Set(packageIds.split(',').map(id => id.trim()).filter(Boolean))];
    if (ids.length === 0) {
        return sendApiError(res, new AppError('BAD_REQUEST', 'packageIds não pode ser vazio', { status: 400 }), req);
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
    const snapshot = await getPatientPendingSnapshot(patientId);

    // Fonte de verdade: Payment records pending.
    // ✅ CORREÇÃO: débito só existe se a sessão foi completada.
    // Agendamentos futuros são "a receber", não dívida real do paciente.
    // Inclui sessions de pacotes — NÃO usa calculateRealPackageDebt.
    const pendingPayments = snapshot.receivablePayments;

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
    const realDebtPayments = snapshot.payments;

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
            availableCredit: snapshot.stats.availableCredit,
            appliedCredit: snapshot.stats.appliedCredit,
            totalPendingNet: snapshot.stats.totalPendingParticularNet,
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
    .populate({
        path: 'appointment',
        select: 'date time sessionValue specialty doctor',
        populate: { path: 'doctor', select: 'fullName specialty' }
    })
    .populate('doctor', 'fullName specialty')
    .lean();

    // Recebimento (recibo) ao qual cada sessão quitada pertence. O recibo agregador
    // (monthly_settlement / debt_settlement) fica fora da lista acima (é não-contabilizável),
    // mas guarda settledPaymentIds + forma de pagamento reais do recebimento. Sem isso a aba
    // Quitados não consegue agrupar "o que foi pago junto" (ex.: 7 sessões quitadas em 29/09).
    const receiptByPaymentId = new Map();
    if (paidPayments.length > 0) {
        const receipts = await Payment.find({
            settledPaymentIds: { $in: paidPayments.map(p => p._id) },
            kind: { $in: [PAYMENT_KIND.MONTHLY_SETTLEMENT, PAYMENT_KIND.DEBT_SETTLEMENT] },
            status: { $nin: ['canceled', 'cancelled', 'refunded'] }
        })
        .select('_id paidAt paymentMethod splitMethods notes amount settledPaymentIds')
        .lean();

        for (const r of receipts) {
            for (const pid of r.settledPaymentIds || []) {
                receiptByPaymentId.set(pid.toString(), r);
            }
        }
    }

    res.json({
        success: true,
        data: paidPayments.map(p => {
            const receipt = receiptByPaymentId.get(p._id.toString());
            return {
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
                description: p.description || null,
                specialty: p.appointment?.specialty || p.doctor?.specialty || p.appointment?.doctor?.specialty || null,
                doctorName: p.doctor?.fullName || p.appointment?.doctor?.fullName || null,
                serviceDate: p.serviceDate || null,
                settlement: receipt ? {
                    id: receipt._id.toString(),
                    paidAt: receipt.paidAt || null,
                    paymentMethod: receipt.paymentMethod || null,
                    splitMethods: receipt.splitMethods || null,
                    totalAmount: receipt.amount,
                    sessionCount: (receipt.settledPaymentIds || []).length,
                    notes: receipt.notes || null
                } : null
            };
        }),
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

/**
 * POST /api/v2/financial/receive
 *
 * Registra um recebimento livre do paciente (aba "Receber"): aplica o valor
 * informado em FIFO sobre as dívidas reais (mesmo critério de
 * GET /patient/:patientId/pending-payments), da mais antiga pra mais nova,
 * quitando apenas sessões inteiras que cabem no valor restante — para na
 * primeira que não cabe, sem pular a ordem cronológica.
 *
 * O que sobrar (valor pago maior que a soma das dívidas quitáveis) vira
 * crédito na conta corrente do paciente (PatientBalance.currentBalance
 * negativo), disponível para abater dívidas futuras.
 *
 * Body: { patientId, amount, method|paymentMethod, mode?: 'auto', notes?, metadata?: { idempotencyKey? } }
 *
 * mode: único suportado hoje é 'auto' (FIFO automático).
 *
 * Idempotência: metadata.idempotencyKey evita reprocessar a mesma requisição
 * (double-click, retry de rede) — reaproveita o campo Payment.bulkSettlementKey
 * (mesmo padrão de idempotência do bulk-settle em payment.v2.js).
 */
router.post('/receive', auth, asyncHandler(async (req, res) => {
    const { patientId, amount, method, paymentMethod, mode = 'auto', notes, metadata } = req.body || {};

    if (!patientId || !mongoose.Types.ObjectId.isValid(patientId)) {
        return sendApiError(res, new AppError('INVALID_PATIENT_ID', 'patientId inválido', { status: 400 }), req);
    }
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
        return sendApiError(
          res,
          new AppError('INVALID_AMOUNT', 'amount deve ser um valor positivo', {
            status: 400,
          }),
          req
        );
    }
    const rawMethod = method || paymentMethod;
    if (!rawMethod || !VALID_PAYMENT_METHODS.includes(rawMethod)) {
        return sendApiError(
          res,
          new AppError('INVALID_PAYMENT_METHOD', 'Método de pagamento inválido', {
            status: 400,
          }),
          req
        );
    }
    if (mode !== 'auto') {
        return sendApiError(
          res,
          new AppError('UNSUPPORTED_MODE', `mode '${mode}' não suportado (use 'auto')`, {
            status: 400,
          }),
          req
        );
    }

    const primaryMethod = normalizePaymentMethod(rawMethod);
    const patientOid = new mongoose.Types.ObjectId(patientId);
    const idempotencyKey = metadata?.idempotencyKey ? String(metadata.idempotencyKey) : null;
    const receiveKey = idempotencyKey ? `receive_${patientId}_${idempotencyKey}` : null;

    const mongoSession = await mongoose.startSession();
    await mongoSession.startTransaction();

    try {
        // 🛡️ Idempotência: se já existe recibo com essa chave, retorna o mesmo resultado sem reprocessar.
        if (receiveKey) {
            const existingReceipt = await Payment.findOne({
                kind: 'monthly_settlement',
                bulkSettlementKey: receiveKey,
                status: { $nin: ['cancelled', 'canceled', 'refunded'] }
            }).session(mongoSession).lean();

            if (existingReceipt) {
                await mongoSession.abortTransaction();
                return res.json({
                    success: true,
                    receiptId: existingReceipt._id,
                    jobId: null,
                    status: 'completed',
                    amount: existingReceipt.amount,
                    patientId,
                    message: 'Recebimento já processado anteriormente (idempotência)',
                    idempotent: true
                });
            }
        }

        const now = new Date();

        // Mesma fonte de verdade de GET /pending-payments: Payment pending, não
        // package_consumed, não convenio/liminar, sessão já completada (ou débito manual).
        const debtPayments = await Payment.find({
            $and: [
                { $or: [{ patient: patientOid }, { patient: patientId }, { patientId }] },
                { status: 'pending' },
                { kind: { $ne: 'package_consumed' } },
                { billingType: { $nin: ['convenio', 'liminar'] } }
            ]
        })
            .populate('appointment', 'date time specialty sessionValue package operationalStatus')
            .session(mongoSession);

        const realDebts = debtPayments
            .filter(p => !p.appointment || p.appointment.operationalStatus === 'completed')
            .map(p => ({
                payment: p,
                competenceDate: p.serviceDate || p.paymentDate || p.appointment?.date || p.createdAt
            }))
            .sort((a, b) => new Date(a.competenceDate) - new Date(b.competenceDate));

        // FIFO: quita sessões inteiras da mais antiga pra mais nova. Para na
        // primeira que não cabe no valor restante — nunca pula pra uma mais
        // nova pra "encaixar melhor", senão quebra a ordem de competência.
        let remainingCents = toCents(numericAmount);
        const toSettle = [];
        for (const { payment } of realDebts) {
            const amtCents = toCents(payment.amount);
            if (amtCents > 0 && amtCents <= remainingCents) {
                toSettle.push(payment);
                remainingCents -= amtCents;
            } else if (amtCents > remainingCents) {
                break;
            }
        }
        const creditCents = remainingCents;
        const settledAmount = fromCents(toCents(numericAmount) - creditCents);

        let receipt = null;
        const affectedPackageIds = [];
        const affectedDates = new Set([moment.tz(now, 'America/Sao_Paulo').format('YYYY-MM-DD')]);

        if (toSettle.length > 0) {
            // 🛡️ FLOW GUARD: mesma validação do bulk-settle antes de tocar em qualquer Payment.
            const { default: FinancialGuard } = await import('../services/financialGuard/index.js');
            const paymentIds = toSettle.map(p => p._id.toString());
            try {
                await FinancialGuard.execute({
                    context: 'SETTLE_PAYMENT',
                    billingType: 'settle',
                    payload: { paymentIds },
                    session: mongoSession
                });
            } catch (flowErr) {
                await mongoSession.abortTransaction();
                return sendApiError(
                  res,
                  new AppError(flowErr.code || 'PAYMENT_FLOW_BLOCKED', flowErr.message, {
                    status: 400,
                    extra: { meta: flowErr.meta || undefined },
                  }),
                  req
                );
            }

            const oldStatusById = new Map(toSettle.map(p => [p._id.toString(), p.status]));

            // 1. Marca os payments selecionados como pago (bulkWrite condicional — mesmo padrão do bulk-settle)
            const bulkOps = toSettle.map(p => ({
                updateOne: {
                    filter: { _id: p._id, status: 'pending' },
                    update: {
                        $set: {
                            status: 'paid',
                            paymentMethod: primaryMethod,
                            paidAt: now,
                            financialDate: now
                        },
                        $unset: { splitMethods: 1 }
                    }
                }
            }));
            const bulkResult = await Payment.bulkWrite(bulkOps, { session: mongoSession });
            if (bulkResult.modifiedCount !== toSettle.length) {
                const error = new Error('Payments alterados concorrentemente durante o recebimento');
                error.code = 'BULK_SETTLEMENT_CONFLICT';
                throw error;
            }

            // 2. Appointments vinculados
            const withAppointment = toSettle.filter(p => p.appointment);
            if (withAppointment.length > 0) {
                await Appointment.bulkWrite(withAppointment.map(p => {
                    const apptId = p.appointment?._id || p.appointment;
                    return {
                        updateOne: {
                            filter: { _id: apptId },
                            update: {
                                $set: {
                                    paymentStatus: 'paid',
                                    isPaid: true,
                                    paymentMethod: mapPaymentMethodToAppointment(primaryMethod),
                                    paymentForms: [{ amount: p.amount, date: now, method: mapPaymentMethodToAppointment(primaryMethod) }]
                                }
                            }
                        }
                    };
                }), { session: mongoSession });
            }

            // 2b. Sessions vinculadas (espelho do estado de pagamento)
            const withSession = toSettle.filter(p => p.session);
            if (withSession.length > 0) {
                await Session.bulkWrite(withSession.map(p => ({
                    updateOne: {
                        filter: { _id: p.session },
                        update: { $set: { paymentStatus: 'paid', isPaid: true, paymentMethod: primaryMethod, paidAt: now } }
                    }
                })), { session: mongoSession });
            }

            // 3. Pacotes afetados: soma Payments quitados, inclusive vínculo pelo Appointment.
            const reconciledPackageIds = await reconcilePackagesForPayments(toSettle, mongoSession, { closeSettled: true });
            affectedPackageIds.push(...reconciledPackageIds);

            // 4. Recibo consolidado auditável (serviceDate = competência mais recente das sessões quitadas)
            const settledDates = toSettle
                .map(p => p.serviceDate || p.paymentDate)
                .filter(Boolean)
                .sort((a, b) => new Date(b) - new Date(a));
            const receiptServiceDate = settledDates[0] ? new Date(settledDates[0]) : now;
            const first = toSettle[0];

            const [createdReceipt] = await Payment.create([{
                patient: first.patient,
                patientId,
                doctor: first.doctor,
                clinicId: first.clinicId || 'default',
                amount: settledAmount,
                status: 'paid',
                paymentDate: now,
                serviceDate: receiptServiceDate,
                paidAt: now,
                financialDate: now,
                paymentMethod: primaryMethod,
                billingType: first.billingType || 'particular',
                kind: 'monthly_settlement',
                settledPaymentIds: toSettle.map(p => p._id),
                bulkSettlementKey: receiveKey || `receive_${patientId}_${now.getTime()}`,
                notes: notes || `Recebimento de ${toSettle.length} sessão(ões) via aba Receber`,
                createdAt: now,
                updatedAt: now
            }], { session: mongoSession });
            receipt = createdReceipt;

            // 4b. Outbox — mesmo padrão do bulk-settle
            const outboxEntries = toSettle.map(p => ({
                eventType: EventTypes.PAYMENT_STATUS_CHANGED,
                payload: {
                    paymentId: p._id.toString(),
                    patientId: p.patient?.toString?.() || p.patientId,
                    appointmentId: (p.appointment?._id || p.appointment)?.toString?.(),
                    sessionId: p.session?.toString?.(),
                    packageId: p.package?.toString?.(),
                    from: oldStatusById.get(p._id.toString()),
                    to: 'paid',
                    amount: p.amount,
                    paymentMethod: primaryMethod,
                    financialDate: now,
                    paidAt: now,
                    kind: p.kind,
                    billingType: p.billingType,
                    isFromPackage: p.isFromPackage,
                    reason: 'financial_receive',
                    userId: req.user?._id?.toString?.()
                },
                aggregateType: 'payment',
                aggregateId: p._id.toString(),
                correlationId: `payment_status_${p._id}_${oldStatusById.get(p._id.toString())}_paid_${Date.now()}`
            }));
            await Promise.all(
                outboxEntries.map(entry =>
                    saveToOutbox(entry, mongoSession).catch(outboxErr => {
                        logger.error(`[V2 financial/receive] Falha ao salvar outbox para ${entry.aggregateId}:`, outboxErr.message);
                        throw outboxErr;
                    })
                )
            );

            for (const p of toSettle) {
                [p.serviceDate, p.paymentDate, p.financialDate].filter(Boolean).forEach(d => {
                    affectedDates.add(moment.tz(d, 'America/Sao_Paulo').format('YYYY-MM-DD'));
                });
            }
        }

        // Excedente vira crédito na conta corrente do paciente.
        // ADR-019: PatientBalance só via updateOne/findOneAndUpdate ($push/$inc) — nunca .save()/addCredit().
        let creditAmount = 0;
        if (creditCents > 0) {
            creditAmount = fromCents(creditCents);
            const creditCorrelationId = `receive_credit_${patientId}_${now.getTime()}`;
            await PatientBalance.findOneAndUpdate(
                { patient: patientOid },
                {
                    $push: {
                        transactions: {
                            type: 'credit',
                            amount: creditAmount,
                            description: notes || 'Crédito de recebimento avulso (valor excedente às sessões em aberto)',
                            paymentMethod: primaryMethod,
                            correlationId: creditCorrelationId,
                            registeredBy: req.user?._id || null,
                            transactionDate: now
                        }
                    },
                    $inc: { currentBalance: -creditAmount, totalCredited: creditAmount },
                    $setOnInsert: { patient: patientOid, createdAt: now },
                    $set: { lastTransactionAt: now }
                },
                { session: mongoSession, upsert: true, new: true }
            );
        }

        await mongoSession.commitTransaction();

        // Invalidação de cache escopada (mesmo padrão do bulk-settle) — só os dias realmente afetados.
        const affectedDatesArr = [...affectedDates];
        const cacheResults = await Promise.allSettled([
            import('./financialDashboard.v2.js').then(({ invalidateDashboardCache }) => invalidateDashboardCache({ dates: affectedDatesArr })),
            clearCashflowCacheForDates(affectedDatesArr, { throwOnError: true })
        ]);
        cacheResults.forEach((result, index) => {
            if (result.status === 'rejected') {
                logger.warn('[V2 financial/receive] Falha ao invalidar cache após commit', {
                    cache: index === 0 ? 'dashboard_ufs' : 'cashflow',
                    affectedDates: affectedDatesArr,
                    error: result.reason?.message
                });
            }
        });

        // Rebuild das PackageViews em background (não bloqueia resposta)
        if (affectedPackageIds.length > 0) {
            Promise.allSettled(
                affectedPackageIds.map(pkgId =>
                    syncAffectedViews({
                        event: 'therapy_package.payment_settled',
                        packageId: pkgId,
                        correlationId: `financial_receive_${pkgId}_${now.getTime()}`
                    })
                )
            ).catch(bgErr => {
                logger.error('[V2 financial/receive] Erro inesperado rebuildando PackageViews em background:', bgErr.message);
            });
        }

        logger.info('[V2 financial/receive] Recebimento processado', {
            patientId,
            amount: numericAmount,
            settledCount: toSettle.length,
            settledAmount,
            creditAmount,
            receiptId: receipt?._id
        });

        return res.json({
            success: true,
            receiptId: receipt?._id || null,
            jobId: null,
            status: 'completed',
            amount: numericAmount,
            patientId,
            message: toSettle.length > 0
                ? `${toSettle.length} sessão(ões) quitada(s)${creditAmount > 0 ? ` + R$ ${creditAmount.toFixed(2)} em crédito` : ''}`
                : `R$ ${creditAmount.toFixed(2)} registrado(s) como crédito (nenhuma dívida elegível)`,
            settled: {
                count: toSettle.length,
                amount: settledAmount,
                paymentIds: toSettle.map(p => p._id)
            },
            credit: creditAmount
        });

    } catch (error) {
        await safeAbortTransaction(mongoSession);
        logger.error('[V2 financial/receive] Erro:', error.message);
        const isConflict = error.code === 'BULK_SETTLEMENT_CONFLICT'
            || error?.errorLabels?.includes?.('TransientTransactionError');
        return res.status(isConflict ? 409 : 500).json({ success: false, error: error.message, code: error.code });
    } finally {
        mongoSession.endSession();
    }
}));

export default router;
