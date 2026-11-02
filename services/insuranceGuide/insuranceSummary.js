/**
 * Números da aba Convênios que dependem do mês ou de fontes fora da ReadView.
 *
 * A ReadView (getInsuranceGuidesView) já devolve os totais por fase (a faturar,
 * documentação enviada, faturado, recebido) somados no backend. Aqui ficam só os
 * complementos, também somados no backend para a tela não recalcular nada:
 *   - recebido no mês pela data do depósito (Payment.insurance.receivedAt) e o mês anterior
 *   - NFs em aberto (lotes com número de NF ainda não recebidos) e a mais antiga
 *   - fila "precisa de ação": sessões sem guia (com valor), rascunhos de envio, guias vencendo
 *   - sessões a faturar/aguardando sem evolução registrada (AVISO, nunca bloqueia faturar)
 *   - glosas do mês (itens de lote processados no mês com glosaAmount)
 *
 * Somente leitura.
 */
import moment from 'moment-timezone';
import Payment from '../../models/Payment.js';
import Session from '../../models/Session.js';
import InsuranceGuide from '../../models/InsuranceGuide.js';
import InsuranceBatch from '../../models/InsuranceBatch.js';
import Doctor from '../../models/Doctor.js';
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

const MISSING_EVOLUTION_IDS_CAP = 2000;

/**
 * Sessões de convênio ainda não faturadas (fase A faturar ou Aguardando NF) que não
 * têm Evolution. Vínculo: Evolution.appointmentId; fallback para evoluções antigas
 * sem appointmentId: mesmo paciente + terapeuta no mesmo dia (índice evolution_per_session).
 */
async function sessionsWithoutEvolution() {
  const rows = await Session.aggregate([
    { $match: {
      status: 'completed',
      insuranceGuide: { $ne: null },
      $and: [
        { $or: [{ billingBatchId: { $exists: false } }, { billingBatchId: null }] },
        { $or: [{ paymentMethod: 'convenio' }, { billingType: 'convenio' }] }
      ]
    } },
    { $lookup: {
      from: 'payments',
      let: { sid: '$_id' },
      pipeline: [
        { $match: { $expr: { $eq: ['$session', '$$sid'] }, status: { $ne: 'canceled' }, 'insurance.status': { $in: ['billed', 'received'] } } },
        { $limit: 1 }, { $project: { _id: 1 } }
      ],
      as: 'billedPayment'
    } },
    { $match: { billedPayment: { $size: 0 } } },
    { $lookup: {
      from: 'evolutions',
      let: { aid: '$appointmentId', pat: '$patient', doc: '$doctor', d: '$date' },
      pipeline: [
        { $match: { $expr: { $or: [
          { $and: [{ $ne: ['$$aid', null] }, { $eq: ['$appointmentId', '$$aid'] }] },
          { $and: [
            { $eq: ['$patient', '$$pat'] }, { $eq: ['$doctor', '$$doc'] },
            { $eq: [
              { $dateToString: { format: '%Y-%m-%d', date: '$date', timezone: TZ } },
              { $dateToString: { format: '%Y-%m-%d', date: '$$d', timezone: TZ } }
            ] }
          ] }
        ] } } },
        { $limit: 1 }, { $project: { _id: 1 } }
      ],
      as: 'evolution'
    } },
    { $match: { evolution: { $size: 0 } } },
    { $project: { _id: 1, doctor: 1 } }
  ]);

  const byDoctor = new Map();
  for (const r of rows) {
    const key = r.doctor ? String(r.doctor) : 'none';
    byDoctor.set(key, (byDoctor.get(key) || 0) + 1);
  }
  const top = [...byDoctor.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const doctorIds = top.map(([id]) => id).filter(id => id !== 'none');
  const names = doctorIds.length
    ? new Map((await Doctor.find({ _id: { $in: doctorIds } }).select('fullName').lean()).map(d => [String(d._id), d.fullName]))
    : new Map();

  return {
    count: rows.length,
    sessionIds: rows.slice(0, MISSING_EVOLUTION_IDS_CAP).map(r => String(r._id)),
    byDoctor: top.map(([id, count]) => ({ doctorId: id === 'none' ? null : id, doctorName: names.get(id) || null, count }))
  };
}

/**
 * Glosa do mês: soma dos itens de lote processados no mês com glosaAmount. Lotes
 * antigos que só registraram o total (sem item) entram pelo totalGlosa quando a
 * liquidação (receivedAt) caiu no mês.
 */
async function glosaBetween(start, end) {
  const s = start.toDate();
  const e = end.toDate();
  const batches = await InsuranceBatch.find({
    $or: [
      { sessions: { $elemMatch: { processedAt: { $gte: s, $lte: e }, glosaAmount: { $gt: 0 } } } },
      { receivedAt: { $gte: s, $lte: e }, totalGlosa: { $gt: 0 } }
    ]
  }).select('totalGlosa receivedAt sessions.glosaAmount sessions.processedAt').lean();

  let amount = 0;
  let sessions = 0;
  for (const b of batches) {
    const items = (b.sessions || []).filter(i => (Number(i.glosaAmount) || 0) > 0);
    const inMonth = items.filter(i => i.processedAt && i.processedAt >= s && i.processedAt <= e);
    if (items.length) {
      sessions += inMonth.length;
      amount += inMonth.reduce((sum, i) => sum + (Number(i.glosaAmount) || 0), 0);
    } else if (b.receivedAt && b.receivedAt >= s && b.receivedAt <= e) {
      amount += Number(b.totalGlosa) || 0;
    }
  }
  return { amount: round(amount), sessions, batches: batches.length };
}

export async function getInsuranceSummary({ month } = {}) {
  const { start, end } = monthRange(month);
  const prev = { start: start.clone().subtract(1, 'month').startOf('month'), end: start.clone().subtract(1, 'month').endOf('month') };
  const now = moment.tz(TZ);

  const [received, receivedPrev, openInvoices, orphanAgg, drafts, expiring, noEvolution, glosa] = await Promise.all([
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
    }),
    sessionsWithoutEvolution(),
    glosaBetween(start, end)
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
      guidesExpiringIn7Days: expiring,
      sessionsWithoutEvolution: noEvolution.count,
      sessionsWithoutEvolutionByDoctor: noEvolution.byDoctor
    },
    // Lista para o chip por sessão na aba A faturar/Aguardando (limitada a 2000 ids).
    sessionsWithoutEvolutionIds: noEvolution.sessionIds,
    glosaInMonth: glosa
  };
}

export default { getInsuranceSummary };
