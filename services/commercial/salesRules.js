// services/commercial/salesRules.js
// Regras puras de Vendas & Marketing (sem banco), para testar sem Mongo.
// Ver docs/SALES_MARKETING.md.
import moment from 'moment-timezone';

const TIMEZONE = 'America/Sao_Paulo';

// Período do PeriodBar (YYYY-MM-DD, dia inteiro em São Paulo) + período anterior de mesmo tamanho.
export function parsePeriod(startStr, endStr, now = new Date()) {
  const valid = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const today = moment(now).tz(TIMEZONE);
  const start = valid(startStr) ? moment.tz(startStr, TIMEZONE).startOf('day') : today.clone().startOf('month');
  let end = valid(endStr) ? moment.tz(endStr, TIMEZONE).endOf('day') : today.clone().endOf('day');
  if (end.isBefore(start)) end = start.clone().endOf('day');
  const days = end.clone().startOf('day').diff(start, 'days') + 1;
  const prevEnd = start.clone().subtract(1, 'ms');
  const prevStart = start.clone().subtract(days, 'days').startOf('day');
  return { start: start.toDate(), end: end.toDate(), prevStart: prevStart.toDate(), prevEnd: prevEnd.toDate(), days };
}

// Telefone só com dígitos, nas duas formas que aparecem no banco (com e sem DDI 55).
export function phoneVariants(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length < 10) return [];
  if (d.startsWith('55') && d.length >= 12) return [d, d.slice(2)];
  return [d, `55${d}`];
}

// Canal comercial a partir da atribuição (fonte confiável) ou da origem do Lead (texto livre).
const CHANNEL_RULES = [
  [/meta_ads|facebook_ads|fb_ads/, 'facebook_ads'],
  [/instagram_ads|ig_ads/, 'instagram_ads'],
  [/google_ads|gads|adwords/, 'google_ads'],
  [/tiktok/, 'tiktok'],
  [/gmb|google_meu|google_business|maps/, 'gmb'],
  [/instagram|^ig$/, 'instagram'],
  [/facebook|^fb$/, 'facebook'],
  [/google|organico|seo/, 'google'],
  [/site|landing|lp/, 'site'],
  [/indica/, 'indicacao'],
  [/whats/, 'whatsapp'],
];

export const CHANNEL_LABELS = {
  facebook_ads: 'Facebook Ads', instagram_ads: 'Instagram Ads', google_ads: 'Google Ads', tiktok: 'TikTok',
  gmb: 'Google (GMB)', instagram: 'Instagram', facebook: 'Facebook', google: 'Google orgânico', site: 'Site',
  indicacao: 'Indicação', whatsapp: 'WhatsApp direto', desconhecido: 'Sem origem',
};

export function channelOf(attributionSource, leadOrigin) {
  for (const raw of [attributionSource, leadOrigin]) {
    const v = String(raw || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!v || v === 'unknown' || v === 'desconhecido') continue;
    const hit = CHANNEL_RULES.find(([re]) => re.test(v));
    return hit ? hit[1] : v;
  }
  return 'desconhecido';
}

export const pct = (part, total) => (total ? Math.round((part / total) * 1000) / 10 : 0);
const r2 = (n) => Math.round(n * 100) / 100;

// Funil de leads a partir de linhas já enriquecidas ({ conversed, scheduled, attended, pack, revenue }).
export function leadFunnel(rows) {
  const t = rows.reduce((a, r) => ({
    leads: a.leads + 1,
    conversed: a.conversed + (r.conversed ? 1 : 0),
    scheduled: a.scheduled + (r.scheduled ? 1 : 0),
    attended: a.attended + (r.attended ? 1 : 0),
    pack: a.pack + (r.pack ? 1 : 0),
    revenue: a.revenue + (r.revenue || 0),
  }), { leads: 0, conversed: 0, scheduled: 0, attended: 0, pack: 0, revenue: 0 });
  t.revenue = r2(t.revenue);
  return t;
}

// Leitura do canal para a tabela de ROI (texto curto, decide onde investir).
export function channelVerdict({ spend, leads, patients }) {
  if (spend > 0 && leads >= 5 && patients === 0) return { tone: 'red', text: 'pausar ou trocar criativo' };
  if (spend > 0 && patients > 0) return { tone: 'green', text: 'escalar' };
  if (!spend && patients > 0) return { tone: 'green', text: 'orgânico forte' };
  if (leads > 0 && patients === 0) return { tone: 'amber', text: 'leads sem fechamento' };
  return { tone: 'gray', text: '—' };
}

export function roiTotals({ spend, leads, patients, revenue }) {
  return {
    spend: r2(spend),
    leads,
    patients,
    revenue: r2(revenue),
    costPerLead: spend > 0 && leads ? r2(spend / leads) : null,
    costPerPatient: spend > 0 && patients ? r2(spend / patients) : null,
    returnMultiple: spend > 0 ? Math.round((revenue / spend) * 10) / 10 : null,
  };
}
