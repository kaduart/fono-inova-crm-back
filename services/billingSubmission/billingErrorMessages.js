/**
 * Mensageria de erros do faturamento (billing submission) — linguagem para o COMERCIAL/secretaria.
 *
 * Problema que resolve: o erro técnico ("Payment 6a3c… está em 'paid' e não pode transicionar
 * para 'billed'") chegava ao toast sem dizer QUAL paciente/sessão, e sem dizer o que fazer.
 *
 * Fluxo: o controller captura o erro → `humanizeBillingError` identifica as sessões envolvidas
 * (paciente, data, guia, valor, situação do pagamento) → `buildBillingMessage` (função pura)
 * monta título, mensagem e ação. O erro técnico original é preservado em `technicalMessage`
 * para suporte/log. Nunca lança: se algo falhar, devolve a mensagem original.
 */
import Session from '../../models/Session.js';
import Payment from '../../models/Payment.js';
import Patient from '../../models/Patient.js';
import InsuranceGuide from '../../models/InsuranceGuide.js';

const MAX_ITEMS_IN_MESSAGE = 5;

const PAYMENT_STATUS_PT = Object.freeze({
  paid: 'já consta como pago',
  billed: 'já foi faturado',
  received: 'já foi recebido do convênio',
  partial: 'tem pagamento parcial',
  pending: 'está pendente',
  pending_billing: 'está pendente de faturamento',
  canceled: 'está cancelado',
});

const INSURANCE_STATUS_PT = Object.freeze({
  pending: 'pendente',
  pending_billing: 'pendente de faturamento',
  billed: 'faturado',
  received: 'recebido',
  rejected: 'rejeitado',
});

const formatMoney = (value) =>
  Number(value) > 0
    ? Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    : null;

function formatDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  // Datas de sessão são gravadas ao meio-dia UTC — usar UTC evita virar o dia.
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}

/** "Paciente — sessão de 29/06/2026 (guia 123) · R$ 80,00" */
export function describeItem(item) {
  const parts = [item.patientName || 'Paciente não identificado'];
  const date = formatDate(item.sessionDate);
  parts.push(date ? `sessão de ${date}` : 'sessão sem data');
  let text = parts.join(' — ');
  if (item.guideNumber) text += ` (guia ${item.guideNumber})`;
  const money = formatMoney(item.amount);
  if (money) text += ` · ${money}`;
  return text;
}

function listItems(items, suffix = () => '') {
  const shown = items.slice(0, MAX_ITEMS_IN_MESSAGE).map((i) => `• ${describeItem(i)}${suffix(i)}`);
  const extra = items.length - shown.length;
  if (extra > 0) shown.push(`• e mais ${extra} sessão(ões)`);
  return shown.join('\n');
}

const plural = (n, one, many) => (n === 1 ? one : many);

/**
 * Catálogo: código → { title, line(items, details), action }.
 * `line` devolve o corpo (sem título); `action` diz quem resolve e o que fazer.
 */
const CATALOG = {
  BILLING_SUBMISSION_PAYMENT_STATUS_NOT_BILLABLE: {
    title: 'Faturamento não realizado — pagamento já baixado',
    line: (items) =>
      `${items.length} ${plural(items.length, 'sessão está', 'sessões estão')} com o pagamento fora de "pendente de faturamento", ` +
      `embora o convênio ainda não tenha pago:\n` +
      listItems(items, (i) => ` — ${PAYMENT_STATUS_PT[i.paymentStatus] || `situação: ${i.paymentStatus}`}`),
    action: 'Avise o financeiro para conferir o pagamento dessa sessão. Nada foi faturado; depois de regularizar, tente novamente.',
  },
  BILLING_SUBMISSION_PAYMENT_NOT_ELIGIBLE: {
    title: 'Faturamento não realizado — pagamento não está pendente de faturamento',
    line: (items) =>
      `${plural(items.length, 'Esta sessão não está', 'Estas sessões não estão')} aptas a faturar:\n` +
      listItems(items, (i) => ` — situação do convênio: ${INSURANCE_STATUS_PT[i.insuranceStatus] || i.insuranceStatus || 'não definida'}`),
    action: 'Remova a sessão do rascunho ou peça ao financeiro para conferir a situação do pagamento.',
  },
  BILLING_SUBMISSION_SESSION_NOT_COMPLETED: {
    title: 'Faturamento não realizado — sessão não concluída',
    line: (items) => `Só sessões concluídas podem ser faturadas:\n${listItems(items)}`,
    action: 'Conclua o atendimento no CRM ou remova a sessão do rascunho.',
  },
  BILLING_SUBMISSION_SESSION_INCOMPLETE: {
    title: 'Faturamento não realizado — sessão sem guia',
    line: (items) => `A sessão precisa ter agendamento e guia de convênio vinculados:\n${listItems(items)}`,
    action: 'Vincule a guia à sessão (Convênios → sessões sem guia) e tente novamente.',
  },
  BILLING_SUBMISSION_SESSION_ALREADY_BILLED: {
    title: 'Faturamento não realizado — sessão já está em outro lote',
    line: (items) => `${plural(items.length, 'Esta sessão já pertence', 'Estas sessões já pertencem')} a um lote de faturamento:\n${listItems(items)}`,
    action: 'Remova a sessão deste rascunho.',
  },
  BILLING_SUBMISSION_PAYMENT_INTEGRITY_CONFLICT: {
    title: 'Faturamento não realizado — pagamentos duplicados',
    line: (items, details) =>
      `Cada sessão deve ter exatamente 1 pagamento de convênio ativo, mas esta tem ${details?.activePayments ?? 'outro número de'}:\n${listItems(items)}`,
    action: 'Acione o suporte para conferir a duplicidade antes de faturar.',
  },
  BILLING_SUBMISSION_PAYMENT_AMOUNT_INVALID: {
    title: 'Faturamento não realizado — sessão sem valor',
    line: (items) => `${plural(items.length, 'Esta sessão está', 'Estas sessões estão')} sem valor válido de convênio:\n${listItems(items)}`,
    action: 'Confira o valor da guia e da sessão e tente novamente.',
  },
};
// O erro técnico das invariantes (levantado no momento de gravar) é o mesmo caso da verificação cedo.
CATALOG.PAYMENT_STATUS_NOT_BILLABLE = CATALOG.BILLING_SUBMISSION_PAYMENT_STATUS_NOT_BILLABLE;

/**
 * Função pura: monta a mensagem. Devolve null se o código não está no catálogo
 * ou não há sessões identificadas (aí o chamador mantém a mensagem original).
 */
export function buildBillingMessage(code, items, details) {
  const entry = CATALOG[code];
  if (!entry || !Array.isArray(items) || items.length === 0) return null;
  const body = entry.line(items, details);
  return {
    title: entry.title,
    message: `${entry.title}\n${body}\n\n${entry.action}`,
    action: entry.action,
  };
}

function collectSessionIds(details) {
  if (!details) return [];
  const ids = [];
  if (details.sessionId) ids.push(String(details.sessionId));
  if (Array.isArray(details.sessionIds)) ids.push(...details.sessionIds.map(String));
  return [...new Set(ids)];
}

/** Carrega paciente/data/guia/valor/situação das sessões envolvidas. */
export async function loadItems(details) {
  let sessionIds = collectSessionIds(details);

  if (!sessionIds.length && details?.paymentId) {
    const payment = await Payment.findById(details.paymentId).select('session').lean();
    if (payment?.session) sessionIds = [String(payment.session)];
  }
  if (!sessionIds.length) return [];

  const sessions = await Session.find({ _id: { $in: sessionIds } })
    .select('_id patient date insuranceGuide')
    .lean();
  const patientIds = [...new Set(sessions.map((s) => String(s.patient)).filter(Boolean))];
  const guideIds = [...new Set(sessions.map((s) => String(s.insuranceGuide)).filter((v) => v && v !== 'undefined' && v !== 'null'))];

  const [patients, guides, payments] = await Promise.all([
    Patient.find({ _id: { $in: patientIds } }).select('fullName name').lean(),
    guideIds.length ? InsuranceGuide.find({ _id: { $in: guideIds } }).select('number').lean() : [],
    Payment.find({ session: { $in: sessionIds }, billingType: 'convenio' })
      .select('session status amount insurance.status insurance.grossAmount')
      .lean(),
  ]);

  const patientName = new Map(patients.map((p) => [String(p._id), p.fullName || p.name]));
  const guideNumber = new Map(guides.map((g) => [String(g._id), g.number]));
  const paymentBySession = new Map(payments.map((p) => [String(p.session), p]));

  return sessions.map((s) => {
    const payment = paymentBySession.get(String(s._id));
    return {
      sessionId: String(s._id),
      patientName: patientName.get(String(s.patient)) || null,
      sessionDate: s.date,
      guideNumber: s.insuranceGuide ? guideNumber.get(String(s.insuranceGuide)) || null : null,
      amount: payment?.insurance?.grossAmount > 0 ? payment.insurance.grossAmount : payment?.amount,
      paymentStatus: payment?.status || null,
      insuranceStatus: payment?.insurance?.status || null,
    };
  });
}

/**
 * Enriquece um erro de faturamento com mensagem para o comercial.
 * @returns {Promise<{ message, technicalMessage, title?, action?, items? }>}
 */
export async function humanizeBillingError(error, { load = loadItems } = {}) {
  const technicalMessage = error?.message || 'Erro ao processar o faturamento';
  try {
    const items = await load(error?.details);
    const built = buildBillingMessage(error?.code, items, error?.details);
    if (!built) return { message: technicalMessage, technicalMessage };
    return { message: built.message, technicalMessage, title: built.title, action: built.action, items };
  } catch {
    return { message: technicalMessage, technicalMessage };
  }
}

export default { describeItem, buildBillingMessage, humanizeBillingError, loadItems };
