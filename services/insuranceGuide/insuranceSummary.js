/**
 * Números da aba Convênios que dependem do mês ou de fontes fora da ReadView.
 *
 * A ReadView (getInsuranceGuidesView) já devolve os totais por fase (a faturar,
 * documentação enviada, faturado, recebido) somados no backend. Aqui ficam só os
 * complementos, também somados no backend para a tela não recalcular nada:
 *   - recebido no mês pela data do depósito (Payment.insurance.receivedAt) e o mês anterior
 *   - NFs em aberto (lotes com número de NF ainda não recebidos) e a mais antiga
 *   - fila "precisa de ação": sessões sem guia (com valor), rascunhos de envio, guias vencendo
 *
 * Somente leitura.
 */
import moment from 'moment-timezone';
import Payment from '../../models/Payment.js';
import Session from '../../models/Session.js';
import InsuranceGuide from '../../models/InsuranceGuide.js';
import BillingSubmission, { BillingSubmissionStatus } from '../../models/BillingSubmission.js';
import { buildInsuranceReceivedFilter } from '../../utils/billingHelpers.js';
import { listInvoiceReceivables } from '../insuranceBatch/InsuranceBatchReceiptService.js';
import { ORPHAN_MATCH } from './insuranceGuidesReadView.js';

const TZ = 'America/Sao_Paulo';
const round = n => Math.round((Number(n) || 0) * 100) / 100;

function monthRange(month) {
  const base = /^\d{4}-\d{2}$/.test(String(month || ''))
    ? moment.tz(`${month}-01`, TZ)
    : moment.tz(TZ).startOf('month');
  return { start: base.clone().startOf('month'), end: base.clone().endOf('month') };
}

async function receivedBetween(start, end) {
  const payments = await Payment.find(
    buildInsuranceReceivedFilter({ $gte: start.toDate(), $lte: end.toDate() })
  ).select('amount insurance.grossAmount insurance.receivedAmount').lean();
  let gross = 0;
  let net = 0;
  for (const p of payments) {
    const g = Number(p.insurance?.grossAmount) || Number(p.amount) || 0;
    gross += g;
    // receivedAmount é o que caiu na conta (pode vir líquido de ISS ou com glosa).
    net += p.insurance?.receivedAmount != null ? Number(p.insurance.receivedAmount) || 0 : g;
  }
  return { sessions: payments.length, gross: round(gross), net: round(net) };
}

export async function getInsuranceSummary({ month } = {}) {
  const { start, end } = monthRange(month);
  const prev = { start: start.clone().subtract(1, 'month').startOf('month'), end: start.clone().subtract(1, 'month').endOf('month') };
  const now = moment.tz(TZ);

  const [received, receivedPrev, openInvoices, orphanAgg, drafts, expiring] = await Promise.all([
    receivedBetween(start, end),
    receivedBetween(prev.start, prev.end),
    listInvoiceReceivables({ status: 'pending' }),
    Session.aggregate([
      { $match: ORPHAN_MATCH },
      { $group: { _id: null, count: { $sum: 1 }, value: { $sum: { $ifNull: ['$sessionValue', 0] } } } }
    ]),
    BillingSubmission.countDocuments({ status: BillingSubmissionStatus.DRAFT }),
    InsuranceGuide.countDocuments({
      status: { $in: ['active', 'linked'] },
      expiresAt: { $gte: now.clone().startOf('day').toDate(), $lte: now.clone().add(7, 'days').endOf('day').toDate() }
    })
  ]);

  const oldest = openInvoices
    .map(r => r.invoiceDate || r.createdAt)
    .filter(Boolean)
    .map(d => new Date(d).getTime())
    .sort((a, b) => a - b)[0];

  const changePercent = receivedPrev.net > 0
    ? round(((received.net - receivedPrev.net) / receivedPrev.net) * 100)
    : null;

  return {
    month: start.format('YYYY-MM'),
    receivedInMonth: { ...received, previousNet: receivedPrev.net, previousMonth: prev.start.format('YYYY-MM'), changePercent },
    openInvoices: {
      count: openInvoices.length,
      pendingAmount: round(openInvoices.reduce((s, r) => s + (Number(r.pendingAmount) || 0), 0)),
      oldestDays: oldest ? Math.max(0, now.diff(moment(oldest), 'days')) : null
    },
    actionQueue: {
      orphanSessions: orphanAgg[0]?.count || 0,
      orphanSessionsValue: round(orphanAgg[0]?.value || 0),
      draftSubmissions: drafts,
      guidesExpiringIn7Days: expiring
    }
  };
}

export default { getInsuranceSummary };
