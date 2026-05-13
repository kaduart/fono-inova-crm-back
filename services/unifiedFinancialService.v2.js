/**
 * 💰 UNIFIED FINANCIAL SERVICE V2 — Fonte única de verdade para Caixa e Produção
 *
 * Regras arquiteturais (imutáveis):
 *   CAIXA     = Payment only. Sempre. Evento imutável no momento do pagamento.
 *   PRODUÇÃO  = Session only. Sempre. Independe de appointment e paciente.
 *
 * HARDENING:
 *   - Caixa NÃO depende de Appointment (imutabilidade financeira)
 *   - Caixa NÃO depende de estado atual de pacote (quitado/pendente)
 *   - Produção NÃO depende de Appointment (sessão realizada = produção)
 *   - Produção NÃO depende de estado do paciente (deletado ou não)
 */

import moment from 'moment-timezone';
import mongoose from 'mongoose';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';
import Package from '../models/Package.js';
import { FinancialTruthLayer } from './financialGuard/FinancialTruthLayer.js';

const TIMEZONE = 'America/Sao_Paulo';

// ============================================================
// 1) CAIXA — Payment only (imutável)
// ============================================================

/**
 * Busca payments válidos para caixa no período.
 *
 * Regras imutáveis:
 *   - status: 'paid'
 *   - amount >= 1
 *   - billingType != 'convenio' (recebimento só quando insurance.receivedAt)
 *   - isFromPackage != true
 *   - kind != 'package_consumed'
 *   - Nome não contém 'teste'
 *
 * 🚨 NÃO filtra por appointment deletado/cancelado — caixa é evento imutável.
 * 🚨 NÃO filtra por pacote quitado — o pagamento ocorreu no dia e não muda.
 */
async function fetchValidPayments(start, end) {
    const payments = await Payment.find({
        status: 'paid',
        amount: { $gt: 0 },
        billingType: { $ne: 'convenio' },
        $or: [
            { financialDate: { $gte: start, $lte: end } },
            { financialDate: { $exists: false }, paymentDate: { $gte: start, $lte: end } },
            { financialDate: null, paymentDate: { $gte: start, $lte: end } }
        ]
    }).populate('patient', 'fullName').lean();

    return payments.filter(p => {
        const nome = (p.patient?.fullName || p.patientName || '').toLowerCase();
        if (nome.includes('teste') || nome.includes('test ')) return false;
        if (p.isFromPackage === true) return false;
        if (p.kind === 'package_consumed') return false;
        return true;
    });
}

export async function calculateCash(start, end) {
    const payments = await fetchValidPayments(start, end);
    const total = payments.reduce((sum, p) => sum + (p.amount || 0), 0);

    let pix = 0, dinheiro = 0, cartao = 0, outros = 0;
    let particular = 0, pacote = 0, convenio = 0, liminar = 0;
    const byMethod = { pix: 0, dinheiro: 0, cartao: 0, outros: 0 };

    for (const p of payments) {
        const method = (p.paymentMethod || '').toLowerCase();
        if (method.includes('pix')) { pix += p.amount; byMethod.pix += p.amount; }
        else if (method.includes('card') || method.includes('cartao') || method.includes('crédito') || method.includes('debito') || method.includes('credit') || method.includes('debit')) { cartao += p.amount; byMethod.cartao += p.amount; }
        else if (method.includes('cash') || method.includes('dinheiro')) { dinheiro += p.amount; byMethod.dinheiro += p.amount; }
        else { outros += p.amount; byMethod.outros += p.amount; }

        // Fonte única: campo estrutural — sem heurística de texto
        if (p.package || p.serviceType === 'package_session' || p.type === 'package') pacote += p.amount;
        else if (p.type === 'insurance' || p.billingType === 'convenio') convenio += p.amount;
        else if (p.billingType === 'liminar') liminar += p.amount;
        else particular += p.amount;
    }

    // Receita Real: desconta pacotes full cujas sessões ainda não foram entregues
    const { receitaReal, receitaDiferida } = await _calcReceitaReal(payments);

    return {
        total,
        receitaReal,
        receitaDiferida,
        particular,
        pacote,
        convenio,
        liminar,
        pix,
        dinheiro,
        cartao,
        outros,
        byMethod,
        count: payments.length,
        payments
    };
}

/**
 * Calcula receita real vs diferida para pacotes full pré-pagos.
 * Receita diferida = valor pago por sessões ainda não realizadas.
 */
async function _calcReceitaReal(payments) {
    const fullPkgPayments = payments.filter(p => p.package && !p.session && !p.appointment);
    if (fullPkgPayments.length === 0) {
        return { receitaReal: payments.reduce((s, p) => s + p.amount, 0), receitaDiferida: 0 };
    }

    const pkgIds = [...new Set(fullPkgPayments.map(p => p.package.toString()))];
    const [pacotes, sessionCounts] = await Promise.all([
        Package.find({ _id: { $in: pkgIds } }, 'sessionValue totalValue totalSessions').lean(),
        Session.aggregate([
            { $match: { package: { $in: pkgIds.map(id => new mongoose.Types.ObjectId(id)) }, status: 'completed' } },
            { $group: { _id: '$package', count: { $sum: 1 } } }
        ])
    ]);

    const pkgMap = new Map(pacotes.map(p => [p._id.toString(), p]));
    const countMap = new Map(sessionCounts.map(s => [s._id.toString(), s.count]));

    let receitaDiferida = 0;
    for (const p of fullPkgPayments) {
        const pkg = pkgMap.get(p.package.toString());
        if (!pkg) continue;
        const sessVal = pkg.sessionValue > 0 ? pkg.sessionValue
            : pkg.totalValue && pkg.totalSessions ? pkg.totalValue / pkg.totalSessions : 0;
        if (sessVal <= 0) continue;
        const feitas = countMap.get(p.package.toString()) || 0;
        const ganho = feitas * sessVal;
        receitaDiferida += Math.max(0, p.amount - ganho);
    }

    const totalCaixa = payments.reduce((s, p) => s + p.amount, 0);
    return { receitaReal: totalCaixa - receitaDiferida, receitaDiferida };
}

export async function calculateCashByDay(start, end) {
    const payments = await fetchValidPayments(start, end);
    const map = new Map();
    for (const p of payments) {
        const key = moment.tz(p.financialDate || p.paymentDate, TIMEZONE).format('YYYY-MM-DD');
        const curr = map.get(key) || { caixa: 0, transacoes: 0 };
        curr.caixa += p.amount;
        curr.transacoes += 1;
        map.set(key, curr);
    }
    return map;
}

// ============================================================
// 2) PRODUÇÃO — Session only (status = 'completed')
// ============================================================

/**
 * Busca sessions completadas no período.
 *
 * Regras imutáveis:
 *   - status: 'completed'
 *   - date no range
 *
 * 🚨 NÃO filtra por appointment deletado/cancelado — produção é execução clínica.
 * 🚨 NÃO filtra por paciente deletado — a sessão foi realizada.
 */
export async function calculateProduction(start, end) {
    const sessions = await Session.find({
        date: { $gte: start, $lte: end },
        status: 'completed'
    }).populate('package', 'sessionValue totalValue totalSessions insuranceGrossAmount').lean();

    // 🔒 TruthLayer V2: substitui isPaid/paymentStatus pelo ledger — nunca lê V1 cru
    const sessionIds = sessions.map(s => s._id);
    const truthSessions = sessionIds.length > 0
        ? await FinancialTruthLayer.getSessions(sessionIds, { withAudit: false })
        : [];
    const truthMap = new Map(truthSessions.map(s => [s._id.toString(), s]));
    const finalSessions = sessions.map(s => {
        const truth = truthMap.get(s._id.toString());
        if (!truth) return s;
        // Sessões de pacote pré-pago: pagamento é no pacote, não por sessão individual.
        // TruthLayer retorna isPaid:false por não encontrar payment — preservar DB.
        if (s.paymentStatus === 'package_paid' || (s.package && s.isPaid === true && !truth.isPaid)) {
            return s;
        }
        return { ...s, isPaid: truth.isPaid, paymentStatus: truth.paymentStatus, _financialSource: 'ledger' };
    });

    let total = 0;
    let particular = 0, convenio = 0, pacote = 0, liminar = 0;
    let recebido = 0, pendente = 0;
    let count = 0;

    for (const s of finalSessions) {
        const valor = s.sessionValue > 0
            ? s.sessionValue
            : s.package?.sessionValue > 0
                ? s.package.sessionValue
                : (s.package?.totalValue && s.package?.totalSessions)
                    ? Math.round(s.package.totalValue / s.package.totalSessions)
                    : 0;

        count += 1;
        if (valor <= 0) continue;
        total += valor;

        const method = (s.paymentMethod || '').toLowerCase();
        const isConvenio = method === 'convenio' || s.paymentOrigin === 'convenio';
        const isLiminar = method === 'liminar_credit' || s.paymentOrigin === 'liminar';
        const isPacote = !!s.package;

        if (isConvenio) convenio += valor;
        else if (isLiminar) liminar += valor;
        else if (isPacote) pacote += valor;
        else particular += valor;

        const foiPago = s.isPaid === true || isConvenio || isLiminar || s.paymentStatus === 'paid' || s.paymentStatus === 'package_paid';
        if (foiPago) recebido += valor;
        else pendente += valor;
    }

    return {
        total,
        particular,
        pacote,
        convenio,
        liminar,
        recebido,
        pendente,
        count,
        sessions: finalSessions
    };
}

export async function calculateProductionByDay(start, end) {
    const result = await calculateProduction(start, end);
    const map = new Map();
    for (const s of result.sessions) {
        const valor = s.sessionValue > 0
            ? s.sessionValue
            : s.package?.sessionValue > 0
                ? s.package.sessionValue
                : (s.package?.totalValue && s.package?.totalSessions)
                    ? Math.round(s.package.totalValue / s.package.totalSessions)
                    : 0;
        if (valor <= 0) continue;
        const key = moment.tz(s.completedAt || s.date, TIMEZONE).format('YYYY-MM-DD');
        const curr = map.get(key) || { producao: 0, atendimentos: 0 };
        curr.producao += valor;
        curr.atendimentos += 1;
        map.set(key, curr);
    }
    return { map, total: result.total, count: result.count, detail: result };
}

export default {
    calculateCash,
    calculateCashByDay,
    calculateProduction,
    calculateProductionByDay
};
