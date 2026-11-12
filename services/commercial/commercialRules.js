// services/commercial/commercialRules.js
// Regras puras das filas comerciais (sem banco), para testar sem Mongo.
// Ver docs/COMMERCIAL_QUEUES.md.

// Lead que ainda pode virar paciente
export const OPEN_LEAD_STATUSES = [
  'novo', 'new', 'engajado', 'atendimento', 'em_andamento', 'lista_espera',
  'lead_quente', 'lead_frio', 'pendencia_documentacao',
];

// Visita anônima do site: o rastreio de jornada (/api/journey/track, leadJourneyService)
// grava um documento em Lead para cada visitante, inclusive robôs e previews da Vercel,
// antes de a pessoa se identificar. Sem nome, sem telefone e sem identificação, não é
// um lead que a equipe possa responder, então fica fora das filas e do funil.
export const ANONYMOUS_VISIT_FILTER = {
  journeyId: { $nin: [null, ''] },
  isIdentified: { $ne: true },
  name: { $in: [null, ''] },
  'contact.phone': { $in: [null, ''] },
};
export const NOT_ANONYMOUS_VISIT = { $nor: [ANONYMOUS_VISIT_FILTER] };

// Mesma regra do filtro acima, em JS (para testes e uso em memória).
const blank = v => v === null || v === undefined || v === '';
export function isAnonymousVisit(lead) {
  return !blank(lead?.journeyId) && lead?.isIdentified !== true && blank(lead?.name) && blank(lead?.contact?.phone);
}

// ─── Fila de leads (aba Leads / card "Leads para retornar") — 12/11/2026 ────
// Quem já agendou ou virou paciente NÃO é lead para a equipe retornar: sair da fila evita
// mensagem comercial para quem já marcou. Vale tanto o funil da secretária (operational.pipeline)
// quanto o status do lead (o agendamento direto grava status 'agendado') e o vínculo com paciente.
export const CLOSED_PIPELINES = ['virou_paciente', 'nao_fechou', 'agendado'];
export const SCHEDULED_LEAD_STATUSES = ['agendado', 'virou_paciente', 'convertido'];
export const OPERATIONAL_QUEUE_FILTER = {
  'operational.pipeline': { $nin: CLOSED_PIPELINES },
  status: { $nin: SCHEDULED_LEAD_STATUSES },
  convertedToPatient: { $in: [null, undefined] },
};

// Mesma regra do filtro acima, em JS.
export function isClosedForQueue(lead) {
  if (!lead) return true;
  if (CLOSED_PIPELINES.includes(lead.operational?.pipeline)) return true;
  if (SCHEDULED_LEAD_STATUSES.includes(lead.status)) return true;
  return !blank(lead.convertedToPatient);
}

// Só os 8 últimos dígitos: o lead grava 55+DDD+número e o paciente grava com ou sem máscara/55.
export function phoneTail(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length >= 8 ? d.slice(-8) : null;
}

// Mesmo critério da Retenção V2: pré-agendado conta como próxima sessão (DOMAIN_INVARIANTS)
export const FUTURE_STATUSES = ['scheduled', 'confirmed', 'pre_agendado'];

const AREA_ALIASES = {
  fono: 'fonoaudiologia',
  fonoaudiologa: 'fonoaudiologia',
  to: 'terapia_ocupacional',
  terapia_ocupacional: 'terapia_ocupacional',
  terapeuta_ocupacional: 'terapia_ocupacional',
  psico: 'psicologia',
  psicologa: 'psicologia',
  neuropsychological: 'neuropsicologia',
  neuropsicologa: 'neuropsicologia',
  neuropediatria: 'neuroped',
  neurologista: 'neuroped',
  fisio: 'fisioterapia',
  psicopedagoga: 'psicopedagogia',
};

export function normalizeArea(value) {
  if (!value || typeof value !== 'string') return '';
  const key = value
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .trim().toLowerCase().replace(/[\s-]+/g, '_');
  return AREA_ALIASES[key] || key;
}

// Desde quando o lead espera resposta da clínica. null = a clínica falou por último.
// Usa a última mensagem do WhatsApp; sem mensagens, a última interação; sem nada, a criação.
export function waitingSince({ createdAt, lastMessage, lastInteraction }) {
  if (lastMessage) return lastMessage.direction === 'inbound' ? new Date(lastMessage.timestamp) : null;
  if (lastInteraction) return lastInteraction.direction === 'inbound' ? new Date(lastInteraction.date) : null;
  return createdAt ? new Date(createdAt) : null;
}

// Prioridade do lead para encaixe: lista de espera e quente primeiro, depois o mais recente
const LEAD_PRIORITY = { lista_espera: 0, lead_quente: 1, engajado: 2, atendimento: 2, em_andamento: 2 };
export function sortFitLeads(leads) {
  return [...leads].sort((a, b) => {
    const pa = LEAD_PRIORITY[a.status] ?? 3;
    const pb = LEAD_PRIORITY[b.status] ?? 3;
    if (pa !== pb) return pa - pb;
    return new Date(b.lastInteractionAt || 0) - new Date(a.lastInteractionAt || 0);
  });
}

// Um paciente pode ter mais de um pacote ativo na mesma especialidade (renovação já feita):
// vale o que tem mais sessões sobrando. Fica na fila quem tem `threshold` ou menos.
// threshold numérico = limite fixo de sessões restantes (comportamento antigo).
// threshold 'auto' = limite proporcional por pacote (renewalThreshold), aprovado em 01/11/2026.
export function packagesEnding(packages, threshold = 2) {
  const limitFor = p => (threshold === 'auto' ? renewalThreshold(p.totalSessions) : threshold);
  const best = new Map();
  for (const p of packages) {
    const pid = p.patient?.toString();
    if (!pid) continue;
    const key = `${pid}|${p.specialty || ''}`;
    const remaining = Math.max(0, (p.totalSessions || 0) - (p.sessionsDone || 0));
    const cur = best.get(key);
    if (!cur || remaining > cur.remaining) best.set(key, { pkg: p, remaining });
  }
  return [...best.values()].filter(e => e.remaining <= limitFor(e.pkg));
}

// Contato registrado recentemente manda o item para o fim da fila, sem esconder
export function sortByRecentContact(items, now = new Date(), coolDays = 7) {
  const cool = coolDays * 86_400_000;
  const contacted = i => i.lastContactAt && now - new Date(i.lastContactAt) < cool;
  return [...items].sort((a, b) => Number(contacted(a)) - Number(contacted(b)));
}

export function daysBetween(from, to = new Date()) {
  if (!from) return null;
  return Math.floor((new Date(to) - new Date(from)) / 86_400_000);
}

// ─── Pacote a 80% (aprovado em 01/11/2026) ───────────────────────────────────
// Gatilho quando faltam até 20% das sessões, com piso de 1. Num pacote de 12 dispara
// em 10/12; num pacote mensal de 4 (1x/semana) dispara em 3/4, porque 80% puro só
// chegaria em 4/4, sem tempo para renovar.
export function renewalThreshold(totalSessions) {
  return Math.max(1, Math.floor((Number(totalSessions) || 0) * 0.2));
}

// Estágio do chip no painel comercial: ok (verde) → renovar (amarelo) → ultima (laranja).
export function renewalStage(remaining, totalSessions) {
  if (remaining <= 1) return 'ultima';
  if (remaining <= renewalThreshold(totalSessions)) return 'renovar';
  return 'ok';
}

// ─── Risco de evasão / churn (aprovado em 01/11/2026) ────────────────────────
// Dias sem sessão futura para entrar no alerta, pela frequência do pacote ativo.
export const CHURN_DAYS = { weekly: 14, biweekly: 21 };
// Janela da "falta justificada": cancelamento pedido pelo paciente (cancelRequester
// 'patient') nos últimos 30 dias tira do alerta. Quem avisou tende a voltar.
export const CHURN_JUSTIFIED_WINDOW_DAYS = 30;
// Pausa registrada pela secretária vale no máximo 90 dias.
export const CHURN_MAX_PAUSE_DAYS = 90;

/**
 * Filtra candidatos (pacientes sem sessão futura) para o alerta de evasão.
 * @param {Array<{patientId:string, daysSince:number}>} candidates
 * @param {object} ctx
 * @param {Set<string>} ctx.activePatients  pacientes com status 'active'
 * @param {Record<string,'weekly'|'biweekly'>} ctx.frequencyByPatient  frequência do pacote ativo
 * @param {Set<string>} ctx.justified  com falta justificada na janela
 * @param {Set<string>} ctx.paused     com pausa vigente
 */
export function churnRisk(candidates, { activePatients, frequencyByPatient = {}, justified, paused }) {
  return candidates
    .filter(c => activePatients.has(c.patientId))
    .filter(c => !justified.has(c.patientId) && !paused.has(c.patientId))
    .map(c => {
      const minDays = CHURN_DAYS[frequencyByPatient[c.patientId]] || CHURN_DAYS.weekly;
      return { ...c, minDays };
    })
    .filter(c => c.daysSince >= c.minDays)
    .map(c => ({
      ...c,
      severity: 'critical',
      title: `Risco de evasão: ${c.name} está sem agendamento há ${c.daysSince} dias`,
    }))
    .sort((a, b) => b.daysSince - a.daysSince);
}

// Texto pronto do WhatsApp de reengajamento (o front abre o WhatsApp; o back não envia).
// Valor antes de qualquer pedido, horário genérico, sem dado clínico.
export function churnMessage(name) {
  const first = String(name || '').trim().split(/\s+/)[0] || '';
  const who = first ? `de ${first}` : 'de vocês';
  return `Oi! Aqui é da Clínica Fono Inova. Sentimos falta ${who} por aqui. `
    + 'A constância das sessões é o que mantém a evolução, e queremos ajudar a retomar. '
    + 'Podemos ver um horário para esta semana, de manhã ou à tarde? 💚';
}

// ─── Pacientes que pararam, mês a mês (alerta de evasão em alta) ───────────────
// "Parou no mês M" = a última sessão realizada do paciente caiu em M e não existe
// nada agendado depois. O mês atual fica de fora da comparação: ainda não fechou
// e quem foi atendido há poucos dias ainda não "parou".
export const STOPPED_SPIKE = { ratio: 1.5, minCount: 5, baselineMonths: 3 };

/**
 * @param {Array<{lastSessionAt: Date, specialty?: string, doctorName?: string}>} rows  um por paciente que parou
 * @param {{ now: Date, months?: number, tz?: string }} opts
 * @returns {{ months: Array<{month, count, baseline, spike, bySpecialty, byDoctor}>, alert: object|null }}
 */
export function stoppedTrend(rows, { now, months = 6, tz = 'America/Sao_Paulo' }) {
  const ym = d => new Date(d).toLocaleDateString('sv-SE', { timeZone: tz }).slice(0, 7);
  const current = ym(now);
  const keys = [];
  const [y, m] = current.split('-').map(Number);
  // Busca meses extras antes da janela só para calcular a média dos primeiros meses
  const total = months + STOPPED_SPIKE.baselineMonths;
  for (let i = total; i >= 1; i -= 1) {
    const d = new Date(Date.UTC(y, m - 1 - i, 15));
    keys.push(d.toISOString().slice(0, 7));
  }
  const bucket = Object.fromEntries(keys.map(k => [k, { count: 0, spec: {}, doc: {} }]));
  for (const r of rows) {
    const b = bucket[ym(r.lastSessionAt)];
    if (!b) continue;
    b.count += 1;
    const s = r.specialty || 'sem especialidade';
    const dn = r.doctorName || 'sem profissional';
    b.spec[s] = (b.spec[s] || 0) + 1;
    b.doc[dn] = (b.doc[dn] || 0) + 1;
  }
  const topN = obj => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([label, value]) => ({ label, value }));
  const all = keys.map((k, i) => {
    const prev = keys.slice(Math.max(0, i - STOPPED_SPIKE.baselineMonths), i).map(p => bucket[p].count);
    const baseline = prev.length ? Math.round((prev.reduce((a, b) => a + b, 0) / prev.length) * 10) / 10 : null;
    const { count } = bucket[k];
    const spike = baseline !== null && count >= STOPPED_SPIKE.minCount && count >= baseline * STOPPED_SPIKE.ratio;
    return { month: k, count, baseline, spike, bySpecialty: topN(bucket[k].spec), byDoctor: topN(bucket[k].doc) };
  });
  const out = all.slice(-months);
  // Alerta = o pico mais recente dos últimos 3 meses fechados
  const recentSpike = [...out].slice(-3).reverse().find(x => x.spike) || null;
  return { months: out, alert: recentSpike };
}
