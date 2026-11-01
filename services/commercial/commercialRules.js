// services/commercial/commercialRules.js
// Regras puras das filas comerciais (sem banco), para testar sem Mongo.
// Ver docs/COMMERCIAL_QUEUES.md.

// Lead que ainda pode virar paciente
export const OPEN_LEAD_STATUSES = [
  'novo', 'new', 'engajado', 'atendimento', 'em_andamento', 'lista_espera',
  'lead_quente', 'lead_frio', 'pendencia_documentacao',
];

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
