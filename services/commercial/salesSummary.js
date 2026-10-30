// services/commercial/salesSummary.js
// KPIs de Vendas & Marketing calculados no back (somente leitura). Ver docs/SALES_MARKETING.md.
// Funil: Lead criado no período → conversou → agendou → compareceu → fechou pacote.
// Receita = CAIXA (buildCashMatch, mesma regra do Financeiro) dos pacientes que vieram desses leads.
import Lead from '../../models/Leads.js';
import Message from '../../models/Message.js';
import Appointment from '../../models/Appointment.js';
import Package from '../../models/Package.js';
import Payment from '../../models/Payment.js';
import LeadAttribution from '../../models/LeadAttribution.js';
import AdSpend from '../../models/AdSpend.js';
import { buildCashMatch } from '../unifiedFinancialService.v2.js';
import {
  parsePeriod, phoneVariants, channelOf, CHANNEL_LABELS, leadFunnel, pct, channelVerdict, roiTotals,
} from './salesRules.js';

const CACHE_TTL_MS = 60_000;
const _cache = new Map();
async function cached(key, fn) {
  const hit = _cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.data;
  const data = await fn();
  _cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  if (_cache.size > 200) _cache.delete(_cache.keys().next().value);
  return data;
}

const NOT_HAPPENED = ['canceled', 'force_cancelled', 'suspended', 'processing_cancel'];
const SCHEDULED_LEAD_STATUSES = ['agendado', 'virou_paciente', 'convertido'];

// Lê o que cada lead virou. 5 consultas em paralelo, todas por _id/índice.
async function enrichLeads(leads, start, end) {
  if (!leads.length) return [];
  const ids = leads.map(l => l._id);
  const pids = leads.map(l => l.convertedToPatient).filter(Boolean);
  const phones = [...new Set(leads.flatMap(l => phoneVariants(l.contact?.phone)))];

  const [msgs, appts, packs, cash, attrs] = await Promise.all([
    Message.aggregate([
      { $match: { lead: { $in: ids } } },
      { $group: { _id: '$lead', inbound: { $sum: { $cond: [{ $eq: ['$direction', 'inbound'] }, 1, 0] } }, outbound: { $sum: { $cond: [{ $eq: ['$direction', 'outbound'] }, 1, 0] } } } },
    ]),
    pids.length ? Appointment.aggregate([
      { $match: { patient: { $in: pids }, isDeleted: { $ne: true }, operationalStatus: { $nin: NOT_HAPPENED } } },
      { $group: { _id: '$patient', total: { $sum: 1 }, completed: { $sum: { $cond: [{ $or: [{ $eq: ['$operationalStatus', 'completed'] }, { $eq: ['$clinicalStatus', 'completed'] }] }, 1, 0] } } } },
    ]) : [],
    pids.length ? Package.distinct('patient', { patient: { $in: pids }, type: { $nin: ['convenio', 'liminar'] }, status: { $ne: 'canceled' } }) : [],
    pids.length ? Payment.aggregate([
      { $match: { ...buildCashMatch(start, end), patient: { $in: pids } } },
      { $group: { _id: '$patient', total: { $sum: '$amount' } } },
    ]) : [],
    phones.length ? LeadAttribution.find({ phone: { $in: phones } }, { phone: 1, source: 1, adId: 1, campaign: 1 }).lean() : [],
  ]);

  const msgMap = new Map(msgs.map(m => [String(m._id), m]));
  const apptMap = new Map(appts.map(a => [String(a._id), a]));
  const packSet = new Set(packs.map(String));
  const cashMap = new Map(cash.map(c => [String(c._id), c.total]));
  const attrMap = new Map(attrs.map(a => [a.phone, a]));

  return leads.map((l) => {
    const pid = l.convertedToPatient ? String(l.convertedToPatient) : null;
    const m = msgMap.get(String(l._id));
    const a = pid ? apptMap.get(pid) : null;
    const attr = phoneVariants(l.contact?.phone).map(p => attrMap.get(p)).find(Boolean) || null;
    return {
      _id: l._id,
      origin: l.origin || null,
      attributed: !!attr,
      channel: channelOf(attr?.source, l.origin),
      conversed: !!(m && m.inbound > 0 && m.outbound > 0),
      scheduled: !!(a?.total) || SCHEDULED_LEAD_STATUSES.includes(l.status),
      attended: !!(a?.completed),
      pack: !!(pid && packSet.has(pid)),
      revenue: pid ? (cashMap.get(pid) || 0) : 0,
    };
  });
}

const leadsIn = (start, end) => Lead.find(
  { createdAt: { $gte: start, $lte: end }, stage: { $ne: 'parceria_profissional' } },
  { contact: 1, origin: 1, status: 1, convertedToPatient: 1, createdAt: 1 },
).lean();

export function leadsSummary(startStr, endStr) {
  const p = parsePeriod(startStr, endStr);
  return cached(`leads:${p.start.toISOString()}:${p.end.toISOString()}`, async () => {
    const [leads, prevNewLeads] = await Promise.all([
      leadsIn(p.start, p.end),
      Lead.countDocuments({ createdAt: { $gte: p.prevStart, $lte: p.prevEnd }, stage: { $ne: 'parceria_profissional' } }),
    ]);
    const rows = await enrichLeads(leads, p.start, p.end);
    const f = leadFunnel(rows);
    return {
      period: { start: p.start, end: p.end, days: p.days },
      kpis: {
        newLeads: f.leads,
        prevNewLeads,
        conversed: f.conversed, conversedRate: pct(f.conversed, f.leads),
        scheduled: f.scheduled, scheduledRate: pct(f.scheduled, f.leads),
        attended: f.attended,
        pack: f.pack,
        revenue: f.revenue,
      },
      funnel: [
        { key: 'leads', label: 'Lead novo', value: f.leads },
        { key: 'conversed', label: 'Conversou', value: f.conversed },
        { key: 'scheduled', label: 'Agendou avaliação', value: f.scheduled },
        { key: 'attended', label: 'Compareceu', value: f.attended },
        { key: 'pack', label: 'Fechou pacote', value: f.pack },
      ],
    };
  });
}

// Gasto por canal: o adKey do AdSpend é o adId/campanha gravado na atribuição.
async function spendByChannel(start, end) {
  const spends = await AdSpend.aggregate([
    { $match: { date: { $gte: start, $lte: end } } },
    { $group: { _id: '$adKey', spend: { $sum: '$amount' } } },
  ]);
  if (!spends.length) return new Map();
  const keys = spends.map(s => s._id);
  const attrs = await LeadAttribution.aggregate([
    { $match: { $or: [{ adId: { $in: keys } }, { campaign: { $in: keys } }] } },
    { $project: { key: { $cond: [{ $in: ['$adId', keys] }, '$adId', '$campaign'] }, source: 1 } },
    { $group: { _id: '$key', source: { $first: '$source' } } },
  ]);
  const srcMap = new Map(attrs.map(a => [a._id, a.source]));
  const out = new Map();
  for (const s of spends) {
    const ch = srcMap.has(s._id) ? channelOf(srcMap.get(s._id)) : 'anuncios_sem_canal';
    out.set(ch, (out.get(ch) || 0) + s.spend);
  }
  return out;
}

export function roiSummary(startStr, endStr) {
  const p = parsePeriod(startStr, endStr);
  return cached(`roi:${p.start.toISOString()}:${p.end.toISOString()}`, async () => {
    const [leads, spendMap] = await Promise.all([leadsIn(p.start, p.end), spendByChannel(p.start, p.end)]);
    const rows = await enrichLeads(leads, p.start, p.end);

    const byCh = new Map();
    for (const r of rows) {
      const c = byCh.get(r.channel) || { leads: 0, patients: 0, revenue: 0 };
      c.leads += 1;
      c.patients += r.pack ? 1 : 0;
      c.revenue += r.revenue;
      byCh.set(r.channel, c);
    }
    for (const ch of spendMap.keys()) if (!byCh.has(ch)) byCh.set(ch, { leads: 0, patients: 0, revenue: 0 });

    const channels = [...byCh.entries()].map(([key, c]) => {
      const spend = spendMap.get(key) || 0;
      return {
        key,
        label: CHANNEL_LABELS[key] || (key === 'anuncios_sem_canal' ? 'Anúncios (sem canal)' : key),
        ...roiTotals({ spend, ...c }),
        verdict: channelVerdict({ spend, ...c }),
      };
    }).sort((a, b) => b.revenue - a.revenue || b.leads - a.leads);

    const tot = channels.reduce((t, c) => ({ spend: t.spend + c.spend, leads: t.leads + c.leads, patients: t.patients + c.patients, revenue: t.revenue + c.revenue }), { spend: 0, leads: 0, patients: 0, revenue: 0 });
    const attributed = rows.filter(r => r.attributed).length;
    const withOrigin = rows.filter(r => r.channel !== 'desconhecido').length;

    return {
      period: { start: p.start, end: p.end, days: p.days },
      totals: roiTotals(tot),
      coverage: { leads: rows.length, attributed, withOrigin, rate: pct(withOrigin, rows.length) },
      channels,
    };
  });
}
