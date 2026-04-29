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
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';

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
        amount: { $gte: 1 },
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
    let particular = 0, pacote = 0, convenio = 0;
    const byMethod = { pix: 0, dinheiro: 0, cartao: 0, outros: 0 };

    for (const p of payments) {
        const method = (p.paymentMethod || '').toLowerCase();
        if (method.includes('pix')) { pix += p.amount; byMethod.pix += p.amount; }
        else if (method.includes('card') || method.includes('cartao') || method.includes('crédito') || method.includes('debito') || method.includes('credit') || method.includes('debit')) { cartao += p.amount; byMethod.cartao += p.amount; }
        else if (method.includes('cash') || method.includes('dinheiro')) { dinheiro += p.amount; byMethod.dinheiro += p.amount; }
        else { outros += p.amount; byMethod.outros += p.amount; }

        const notes = (p.notes || '').toLowerCase();
        const desc = (p.description || '').toLowerCase();
        if (notes.includes('pacote') || desc.includes('pacote') || p.type === 'package' || p.serviceType === 'package_session') pacote += p.amount;
        else if (notes.includes('convênio') || desc.includes('convenio') || p.type === 'insurance' || p.billingType === 'convenio') convenio += p.amount;
        else particular += p.amount;
    }

    return {
        total,
        particular,
        pacote,
        convenio,
        pix,
        dinheiro,
        cartao,
        outros,
        byMethod,
        count: payments.length,
        payments
    };
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

    let total = 0;
    let particular = 0, convenio = 0, pacote = 0, liminar = 0;
    let recebido = 0, pendente = 0;
    let count = 0;

    for (const s of sessions) {
        const valor = s.sessionValue > 0
            ? s.sessionValue
            : s.package?.sessionValue > 0
                ? s.package.sessionValue
                : (s.package?.totalValue && s.package?.totalSessions)
                    ? Math.round(s.package.totalValue / s.package.totalSessions)
                    : 0;

        if (valor <= 0) continue;
        total += valor;
        count += 1;

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
        sessions
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
        const key = moment.tz(s.date, TIMEZONE).format('YYYY-MM-DD');
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
