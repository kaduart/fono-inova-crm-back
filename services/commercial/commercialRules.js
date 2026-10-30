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
export function packagesEnding(packages, threshold = 2) {
  const best = new Map();
  for (const p of packages) {
    const pid = p.patient?.toString();
    if (!pid) continue;
    const key = `${pid}|${p.specialty || ''}`;
    const remaining = Math.max(0, (p.totalSessions || 0) - (p.sessionsDone || 0));
    const cur = best.get(key);
    if (!cur || remaining > cur.remaining) best.set(key, { pkg: p, remaining });
  }
  return [...best.values()].filter(e => e.remaining <= threshold);
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
