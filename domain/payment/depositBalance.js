// domain/payment/depositBalance.js
//
// 🎯 SINAL + SALDO — consulta particular parcelada em dois Payments distintos.
//
// Contexto (2026-09-04): pré-agendamento de neuropediatria cobra um sinal na
// hora de marcar (ex: R$50 de uma consulta de R$500) e o restante (R$450) é
// pago no dia. Caixa Real / Meta Realizada (unifiedFinancialService.v2.js)
// somam `Payment.amount` diretamente via `Payment.aggregate({status:'paid'})`
// — não leem o FinancialLedger. Por isso o desenho é DOIS documentos Payment
// (cada um vira 'paid' na sua própria data real), não um único Payment com
// campos `paidAmount`/`remainingAmount`: a soma automática do Caixa já
// funciona sem tocar na fórmula canônica (proibido por
// back/docs/FINANCIAL_SOURCE_OF_TRUTH.md).
//
// `Payment.kind` permanece 'session_payment' nos dois — kind descreve a
// NATUREZA do Payment (sessão avulsa vs. pacote vs. quitação), não seu PAPEL
// dentro de uma mesma obrigação parcelada. O papel vive em `paymentRole`
// ('deposit' | 'balance' | 'standard'), eixo ortogonal, protegido por um
// índice único próprio (ver models/Payment.js).
//
// Ver back/docs/FINANCIAL_SOURCE_OF_TRUTH.md#payment-role para a explicação
// de negócio completa (Caixa/Meta/Produção) e
// back/scripts/migrations/2026-09-04-payment-role-deposit-balance.js para a
// migração de índice + backfill.
//
// 🛡️ CONTRATO — depositAmount > 0 NÃO significa "solicitado", significa
// "recebido agora": este domínio não tem (e não deve ganhar) um estado
// intermediário "sinal solicitado, aguardando confirmação". `depositAmount`
// só deve ser enviado pela agenda externa DEPOIS que a secretária confirma
// que o dinheiro já está com a clínica — o rótulo do campo na UI
// (AppointmentModal.jsx) é literalmente "Valor recebido agora", não "Valor
// combinado"/"Valor a cobrar". `createDepositAndBalancePayments()` reforça
// isso estruturalmente: SEMPRE cria o Payment de sinal com `status:'paid'` +
// `paidAt`/`financialDate` preenchidos — nunca `'pending'`. Não existe
// caminho no código para um `paymentRole:'deposit'` nascer como promessa.
// Consequência auditável: como todo `Payment.status='pending'` (inclusive um
// hipotético deposit criado por fora deste helper) é ignorado pelas somas de
// Caixa Real/Meta Realizada (unifiedFinancialService.v2.js só soma
// `status:'paid'`), um "sinal apenas solicitado" — se algum dia alguém criar
// um por fora, incorretamente, como 'pending' — nunca entra em caixa nem em
// meta por construção da fórmula canônica, não por uma checagem específica
// deste arquivo. Ver teste "Contrato: depositAmount > 0 não significa
// dinheiro recebido" em tests/integration/depositBalanceCommands.integration.test.js.

import Payment from '../../models/Payment.js';
import Appointment from '../../models/Appointment.js';
import { recordPaymentReceived } from '../../services/financialLedgerService.js';

export const PAYMENT_ROLE = Object.freeze({
    STANDARD: 'standard',
    DEPOSIT: 'deposit',
    BALANCE: 'balance',
});

// Papéis que representam "o Payment que cobre/vai cobrir o valor da consulta"
// — nunca o sinal. Usado por todo lookup que hoje busca "o payment do
// appointment" para liquidar/editar/cancelar.
const SETTLEMENT_ROLES = [PAYMENT_ROLE.BALANCE, PAYMENT_ROLE.STANDARD];
const ACTIVE_STATUS_FILTER = { $nin: ['cancelled', 'canceled'] };

/**
 * Erro de domínio: o novo valor total da consulta ficaria menor que o sinal
 * já efetivamente recebido. Nunca deve resultar em saldo negativo nem em
 * sobrescrita silenciosa do sinal.
 */
export class DepositExceedsTotalError extends Error {
    constructor(newTotal, depositPaid) {
        super(
            `Novo valor total (R$${Number(newTotal).toFixed(2)}) não pode ser menor que o sinal já recebido (R$${Number(depositPaid).toFixed(2)}).`
        );
        this.name = 'DepositExceedsTotalError';
        this.code = 'DEPOSIT_EXCEEDS_NEW_TOTAL';
        this.status = 409;
        this.newTotal = newTotal;
        this.depositPaid = depositPaid;
    }
}

/**
 * Erro de domínio: alguma operação tentou localizar/alterar o Payment de
 * papel 'deposit' por um caminho reservado ao saldo. Isso nunca deveria
 * acontecer sob o desenho atual (appointment.payment sempre aponta pro
 * saldo) — existe como airbag defensivo, não como fluxo esperado.
 */
export class DepositPaymentProtectedError extends Error {
    constructor(paymentId) {
        super(`Payment ${paymentId} é o sinal (paymentRole='deposit') e não pode ser sobrescrito pelo fluxo de saldo.`);
        this.name = 'DepositPaymentProtectedError';
        this.code = 'DEPOSIT_PAYMENT_PROTECTED';
        this.status = 409;
        this.paymentId = paymentId;
    }
}

export class DepositAlreadyReceivedError extends Error {
    constructor(existingAmount, requestedAmount) {
        super(`Já existe um sinal recebido de R$${Number(existingAmount).toFixed(2)}. O valor contabilizado não pode ser sobrescrito por R$${Number(requestedAmount).toFixed(2)}.`);
        this.name = 'DepositAlreadyReceivedError';
        this.code = 'DEPOSIT_ALREADY_RECEIVED';
        this.status = 409;
        this.existingAmount = existingAmount;
        this.requestedAmount = requestedAmount;
    }
}

function activeMatch(extra = {}) {
    return { status: ACTIVE_STATUS_FILTER, ...extra };
}

/**
 * Busca o Payment de SINAL ativo de uma consulta particular (ou null).
 */
export async function findDepositPayment({ appointmentId, billingType = 'particular' }, mongoSession) {
    const query = Payment.findOne(activeMatch({
        appointment: appointmentId,
        billingType,
        paymentRole: PAYMENT_ROLE.DEPOSIT,
    }));
    if (mongoSession) query.session(mongoSession);
    return query;
}

/**
 * Busca o Payment que representa o SALDO/valor total da consulta (papel
 * 'balance' quando há sinal, ou 'standard' quando não há — o fluxo legado
 * de 1 Payment por consulta). NUNCA retorna o sinal.
 */
export async function findBalancePayment({ appointmentId, billingType = 'particular' }, mongoSession) {
    const query = Payment.findOne(activeMatch({
        appointment: appointmentId,
        billingType,
        paymentRole: { $in: SETTLEMENT_ROLES },
    }));
    if (mongoSession) query.session(mongoSession);
    return query;
}

/**
 * Airbag: garante que um Payment resolvido por outro caminho (ex: fallback
 * heurístico legado por appointment/session sem passar por findBalancePayment)
 * não é o sinal antes de qualquer $set nele. Lança DepositPaymentProtectedError
 * se for.
 */
export function assertNotDepositPayment(payment) {
    if (payment && payment.paymentRole === PAYMENT_ROLE.DEPOSIT) {
        throw new DepositPaymentProtectedError(payment._id);
    }
}

/**
 * Soma quanto já foi efetivamente recebido (status='paid') para a consulta,
 * entre todos os Payments ativos (sinal + saldo), e calcula o saldo restante.
 * Nunca negativo. Fonte única para "quanto falta pagar" — nunca armazenado,
 * sempre derivado (mesmo padrão de Package.remainingSessions).
 */
export async function computeAppointmentBalance({ appointmentId, billingType = 'particular', sessionValue }, mongoSession) {
    const query = Payment.find(activeMatch({ appointment: appointmentId, billingType }))
        .select('amount status paymentRole');
    if (mongoSession) query.session(mongoSession);
    const payments = await query.lean();

    const paidTotal = payments
        .filter((p) => p.status === 'paid')
        .reduce((sum, p) => sum + (p.amount || 0), 0);

    const deposit = payments.find((p) => p.paymentRole === PAYMENT_ROLE.DEPOSIT) || null;
    const balance = payments.find((p) => SETTLEMENT_ROLES.includes(p.paymentRole)) || null;

    return {
        sessionValue: Number(sessionValue) || 0,
        paidTotal,
        remainingAmount: Math.max((Number(sessionValue) || 0) - paidTotal, 0),
        depositAmount: deposit?.amount || 0,
        depositPaid: deposit?.status === 'paid',
        balancePaymentId: balance?._id || null,
        depositPaymentId: deposit?._id || null,
    };
}

/**
 * Valida uma edição de valor total (Appointment.sessionValue). Regra de
 * domínio obrigatória: o novo total nunca pode ficar menor que o sinal já
 * efetivamente pago — não há como "sobrescrever" dinheiro que já entrou.
 */
export function assertNewTotalCoversPaidDeposit(newTotal, depositPaidAmount) {
    if (Number(depositPaidAmount) > 0 && Number(newTotal) < Number(depositPaidAmount)) {
        throw new DepositExceedsTotalError(newTotal, depositPaidAmount);
    }
}

/**
 * Cria os dois Payments (sinal pago + saldo pendente) de forma idempotente:
 * uma segunda chamada com o mesmo appointment+billingType (retry de rede,
 * clique duplo) encontra o índice único {appointment,billingType,paymentRole}
 * e devolve os documentos já existentes em vez de duplicar — mesmo padrão de
 * catch-11000-e-reconsulta já usado em financialLedgerService.recordPaymentReceived.
 *
 * @returns {Promise<{depositPayment: Payment, balancePayment: Payment, created: boolean}>}
 */
export async function createDepositAndBalancePayments(params, mongoSession) {
    const {
        patientId,
        doctorId,
        appointmentId,
        sessionId,
        billingType = 'particular',
        sessionValue,
        depositAmount,
        depositPaymentMethod,
        depositPaidAt,
        balancePaymentMethod,
        correlationId,
        userId,
    } = params;

    const total = Number(sessionValue) || 0;
    const deposit = Number(depositAmount) || 0;
    const remaining = Math.max(total - deposit, 0);
    const paidAt = depositPaidAt ? new Date(depositPaidAt) : new Date();

    // Idempotência: se os dois já existem (retry), retorna sem recriar.
    const [existingDeposit, existingBalance] = await Promise.all([
        findDepositPayment({ appointmentId, billingType }, mongoSession),
        findBalancePayment({ appointmentId, billingType }, mongoSession),
    ]);
    if (existingDeposit && Number(existingDeposit.amount) !== deposit) {
        throw new DepositAlreadyReceivedError(existingDeposit.amount, deposit);
    }

    let depositPayment = existingDeposit;
    let balancePayment = existingBalance;
    let depositWasCreated = false;

    try {
        if (balancePayment?.paymentRole === PAYMENT_ROLE.STANDARD) {
            if (balancePayment.status === 'paid') {
                // Compatibilidade com recebimento parcial legado: o fluxo antigo
                // reduzia o Payment para o valor efetivamente recebido, mas não
                // possuía paymentRole. Se esse valor é exatamente o sinal agora
                // confirmado, preserve o dinheiro/ledger e promova o documento
                // existente a deposit; um novo balance será criado abaixo.
                if (deposit > 0 && Number(balancePayment.amount) === deposit && total > deposit) {
                    balancePayment.paymentRole = PAYMENT_ROLE.DEPOSIT;
                    balancePayment.description = 'Sinal recebido no pré-agendamento';
                    balancePayment.notes = 'Sinal (entrada) — migrado de recebimento parcial legado';
                    await balancePayment.save({ session: mongoSession });
                    depositPayment = balancePayment;
                    balancePayment = null;
                } else {
                    const error = new Error('O pagamento desta consulta já foi integralmente recebido. Não é possível registrar um sinal adicional.');
                    error.code = 'PAYMENT_ALREADY_SETTLED';
                    error.status = 409;
                    throw error;
                }
            } else {
                balancePayment.paymentRole = PAYMENT_ROLE.BALANCE;
                balancePayment.amount = remaining;
                balancePayment.description = 'Saldo da consulta (após sinal)';
                balancePayment.notes = `Saldo restante após sinal de R$${deposit.toFixed(2)}`;
                balancePayment.paymentMethod = balancePaymentMethod || balancePayment.paymentMethod || 'pix';
                balancePayment.status = remaining > 0 ? 'pending' : 'paid';
                await balancePayment.save({ session: mongoSession });
            }
        }

        if (existingDeposit && balancePayment) {
            return { depositPayment: existingDeposit, balancePayment, created: false };
        }

        if (!depositPayment) {
            [depositPayment] = await Payment.create([{
                patient: patientId,
                doctor: doctorId,
                appointment: appointmentId,
                session: sessionId,
                amount: deposit,
                paymentDate: paidAt,
                paidAt,
                financialDate: paidAt,
                paymentMethod: depositPaymentMethod || 'pix',
                status: 'paid',
                serviceType: 'session',
                billingType,
                kind: 'session_payment',
                paymentRole: PAYMENT_ROLE.DEPOSIT,
                correlationId,
                description: 'Sinal recebido no pré-agendamento',
                notes: 'Sinal (entrada) — saldo cobrado separadamente no atendimento',
            }], { session: mongoSession });
            depositWasCreated = true;
        }

        if (!balancePayment) {
            [balancePayment] = await Payment.create([{
                patient: patientId,
                doctor: doctorId,
                appointment: appointmentId,
                session: sessionId,
                amount: remaining,
                paymentDate: new Date(),
                paymentMethod: balancePaymentMethod || 'pix',
                status: remaining > 0 ? 'pending' : 'paid',
                ...(remaining <= 0 ? { paidAt: new Date(), financialDate: new Date() } : {}),
                serviceType: 'session',
                billingType,
                kind: 'session_payment',
                paymentRole: PAYMENT_ROLE.BALANCE,
                correlationId,
                description: 'Saldo da consulta (após sinal)',
                notes: `Saldo restante após sinal de R$${deposit.toFixed(2)}`,
            }], { session: mongoSession });
        }
    } catch (err) {
        // 🛡️ Colisão no índice único {appointment,billingType,paymentRole} — outra
        // chamada concorrente (retry da agenda externa) já criou o mesmo papel.
        // Reconsulta e devolve o existente em vez de propagar erro, mesmo padrão
        // de recordPaymentReceived().
        if (err?.code === 11000) {
            const [fallbackDeposit, fallbackBalance] = await Promise.all([
                findDepositPayment({ appointmentId, billingType }, mongoSession),
                findBalancePayment({ appointmentId, billingType }, mongoSession),
            ]);
            if (fallbackDeposit && fallbackBalance) {
                return { depositPayment: fallbackDeposit, balancePayment: fallbackBalance, created: false };
            }
        }
        throw err;
    }

    // Caixa Real já soma o sinal automaticamente (status='paid', filtro direto em
    // Payment.amount) — mas o ledger é a trilha de auditoria/reconciliação oficial
    // (workers/reconciliationWorker.js). Cada Payment tem seu próprio _id, então
    // recordPaymentReceived credita cada um em seu ciclo próprio, sem colisão.
    if (depositWasCreated) {
        await recordPaymentReceived(
            depositPayment,
            { userId, correlationId: `${correlationId || appointmentId}_deposit` },
            mongoSession
        );
    }

    return { depositPayment, balancePayment, created: true };
}

/**
 * Recalcula `Appointment.payment`/`paymentStatus`/`isPaid` a partir dos
 * Payments ATIVOS que sobram depois de um Payment sair de cena (excluído por
 * hard-delete admin, ou qualquer outro caminho que remova um Payment sem
 * passar pelo ciclo normal de cancelamento). Nunca zera cegamente — sob
 * sinal+saldo pode sobrar um segundo Payment (ex: apagar o saldo não pode
 * apagar o fato de que o sinal continua pago).
 *
 * Papel preferencial pra representar o appointment: saldo/standard antes de
 * sinal — um sinal sozinho, ativo, nunca significa "consulta paga" (a
 * consulta continua tendo um saldo em aberto).
 *
 * @returns {Promise<{primary: Object|null, paymentStatus: string, isPaid: boolean}>}
 */
export async function recomputeAppointmentPaymentState(appointmentId, excludePaymentId, mongoSession) {
    const query = Payment.find({
        $or: [
            { appointment: appointmentId },
            { appointmentId: appointmentId.toString() },
        ],
        status: { $nin: ['cancelled', 'canceled'] },
        _id: { $ne: excludePaymentId },
    });
    if (mongoSession) query.session(mongoSession);
    const remaining = await query.lean();

    const primary = remaining.find((p) => p.paymentRole !== PAYMENT_ROLE.DEPOSIT) || remaining[0] || null;
    const paymentStatus = primary ? (primary.status === 'paid' ? 'paid' : 'pending') : 'pending';
    const isPaid = primary ? primary.status === 'paid' : false;

    // 🛡️ financialSanitizer (models/plugins/financialSanitizer.js) descarta
    // silenciosamente isPaid/paymentStatus de qualquer update em Appointment
    // sem essa flag — mesmo mecanismo já usado em updateAppointmentCommand.js.
    // Sem isso, o recálculo "funciona" (não lança erro) mas não escreve nada.
    const updateQuery = Appointment.findByIdAndUpdate(
        appointmentId,
        { $set: { payment: primary ? primary._id : null, paymentStatus, isPaid } },
        { __fromFinancialGuard: true, __guardContext: 'FINANCIAL' }
    );
    if (mongoSession) updateQuery.session(mongoSession);
    await updateQuery;

    return { primary, paymentStatus, isPaid };
}

export default {
    PAYMENT_ROLE,
    DepositExceedsTotalError,
    DepositPaymentProtectedError,
    DepositAlreadyReceivedError,
    findDepositPayment,
    findBalancePayment,
    assertNotDepositPayment,
    computeAppointmentBalance,
    assertNewTotalCoversPaidDeposit,
    createDepositAndBalancePayments,
    recomputeAppointmentPaymentState,
};
