/**
 * Regras puras do agendamento público (link da bio do Instagram / página /agendar do site).
 * Sem acesso a banco: tudo aqui é testável em unidade. Doc: docs/flows/public_booking_flow.md
 */
import crypto from 'node:crypto';

export const PERIODS = Object.freeze({
  manha: { label: 'de manhã', from: '00:00', to: '11:59' },
  tarde: { label: 'à tarde', from: '12:00', to: '23:59' },
});

const DEFAULT_SPECIALTIES = [
  'fonoaudiologia',
  'psicologia',
  'terapia_ocupacional',
  'neuropsicologia',
  'psicopedagogia',
  'fisioterapia',
];

const DAY_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const DAY_NAMES = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

export const MAX_DAYS = 14;

export function isPublicBookingEnabled(env = process.env) {
  return String(env.PUBLIC_BOOKING_ENABLED || '').toLowerCase() === 'true';
}

export function allowedSpecialties(env = process.env) {
  const raw = String(env.PUBLIC_BOOKING_SPECIALTIES || '').trim();
  if (!raw) return DEFAULT_SPECIALTIES;
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function dailyCap(env = process.env) {
  const n = parseInt(env.PUBLIC_BOOKING_DAILY_CAP, 10);
  return Number.isFinite(n) && n >= 0 ? n : 15;
}

export function periodOf(time) {
  if (typeof time !== 'string' || !/^\d{2}:\d{2}/.test(time)) return null;
  return time.slice(0, 5) < '12:00' ? 'manha' : 'tarde';
}

/** YYYY-MM-DD de hoje em São Paulo */
export function todaySP(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now);
}

export function addDaysYMD(ymd, n) {
  const d = new Date(`${ymd}T12:00:00-03:00`);
  d.setUTCDate(d.getUTCDate() + n);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d);
}

export function dayLabel(ymd) {
  const d = new Date(`${ymd}T12:00:00-03:00`);
  const [, m, day] = ymd.split('-');
  return `${DAY_LABELS[d.getUTCDay()]} ${day}/${m}`;
}

export function displayText(ymd, period) {
  const d = new Date(`${ymd}T12:00:00-03:00`);
  const [, m, day] = ymd.split('-');
  return `${DAY_NAMES[d.getUTCDay()]} ${day}/${m} ${PERIODS[period]?.label || ''}`.trim();
}

/** Janela pública: de amanhã até MAX_DAYS dias à frente. */
export function isDateInWindow(ymd, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || ''))) return false;
  const first = addDaysYMD(todaySP(now), 1);
  const last = addDaysYMD(todaySP(now), MAX_DAYS);
  return ymd >= first && ymd <= last;
}

/**
 * Slots que o público pode pegar: livres e sem "sombra" de paciente recorrente
 * (shadow pattern = horário que um paciente da casa costuma usar).
 */
export function publicFreeSlots(slots = []) {
  return slots.filter((s) => s && s.available === true && !s.signals?.isShadow && periodOf(s.time));
}

/**
 * Escolhe o horário real de um período.
 * candidates: [{ doctorId, slots: [{time, available, signals?}] }]
 * Regra: profissional com mais horários livres no dia (menos ocupado); dentro dele, o primeiro horário do período.
 */
export function pickSlotForPeriod(candidates = [], period) {
  const ranked = candidates
    .map((c) => {
      const free = publicFreeSlots(c.slots);
      const inPeriod = free.filter((s) => periodOf(s.time) === period).map((s) => s.time.slice(0, 5)).sort();
      return { doctorId: c.doctorId, freeCount: free.length, inPeriod };
    })
    .filter((c) => c.inPeriod.length > 0)
    .sort((a, b) => b.freeCount - a.freeCount || a.inPeriod[0].localeCompare(b.inPeriod[0]));
  if (!ranked.length) return null;
  return { doctorId: ranked[0].doctorId, time: ranked[0].inPeriod[0], alternatives: ranked.slice(1) };
}

/** Períodos com vaga de um dia, a partir dos slots de todos os profissionais. */
export function periodsAvailability(candidates = []) {
  const has = { manha: false, tarde: false };
  for (const c of candidates) {
    for (const s of publicFreeSlots(c.slots)) has[periodOf(s.time)] = true;
  }
  return [
    { period: 'manha', available: has.manha },
    { period: 'tarde', available: has.tarde },
  ];
}

export function onlyDigits(v) {
  return String(v || '').replace(/\D/g, '');
}

/** Telefone BR com DDD (10 ou 11 dígitos), aceitando 55 na frente. Devolve só dígitos sem o 55. */
export function normalizeBRPhone(v) {
  let d = onlyDigits(v);
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) return null;
  return d;
}

function cleanName(v, max = 120) {
  const s = String(v || '').replace(/\s+/g, ' ').trim();
  if (s.length < 3 || s.length > max) return null;
  if (!/[a-zA-ZÀ-ÿ]{2,}/.test(s)) return null;
  if (/[<>{}$\\]/.test(s)) return null;
  return s;
}

/**
 * Valida o corpo do POST /hold. Devolve { ok, errors, data }.
 * Mensagens em pt-BR para a página mostrar direto.
 */
export function validateHoldPayload(body = {}, { now = new Date(), env = process.env } = {}) {
  const errors = {};
  const specialty = String(body.specialty || '').toLowerCase();
  if (!allowedSpecialties(env).includes(specialty)) errors.specialty = 'Escolha uma especialidade.';

  const date = String(body.date || '');
  if (!isDateInWindow(date, now)) errors.date = 'Escolha um dia da lista.';

  const period = String(body.period || '');
  if (!PERIODS[period]) errors.period = 'Escolha manhã ou tarde.';

  const childName = cleanName(body.child?.fullName);
  if (!childName) errors.childName = 'Informe o nome completo da criança.';

  const birthDate = String(body.child?.birthDate || '');
  const validBirth = /^\d{4}-\d{2}-\d{2}$/.test(birthDate)
    && birthDate >= '1920-01-01'
    && birthDate <= todaySP(now)
    && !Number.isNaN(new Date(`${birthDate}T12:00:00Z`).getTime());
  if (!validBirth) errors.birthDate = 'Informe a data de nascimento.';

  const responsibleName = cleanName(body.responsible?.name);
  if (!responsibleName) errors.responsibleName = 'Informe o nome do responsável.';

  const phone = normalizeBRPhone(body.responsible?.phone);
  if (!phone) errors.phone = 'Informe um WhatsApp com DDD.';

  if (body.consentLgpd !== true) errors.consentLgpd = 'É preciso aceitar o uso dos dados para o agendamento.';

  const utm = {};
  for (const k of ['source', 'medium', 'campaign', 'content']) {
    const v = body.utm?.[k];
    if (typeof v === 'string' && v.trim()) utm[k] = v.trim().slice(0, 80);
  }

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    data: { specialty, date, period, childName, birthDate, responsibleName, phone, utm },
  };
}

/** Campo isca: humano nunca preenche. */
export function isHoneypotFilled(body = {}) {
  return typeof body.website === 'string' && body.website.trim() !== '';
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function generateBookingCode() {
  const bytes = crypto.randomBytes(6);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return `FI-${out}`;
}

export function isValidBookingCode(code) {
  return /^FI-[A-Z2-9]{6}$/.test(String(code || ''));
}

export function publicStatusOf(operationalStatus) {
  if (operationalStatus === 'pre_agendado') return 'reservado';
  if (['scheduled', 'confirmed', 'paid', 'completed'].includes(operationalStatus)) return 'confirmado';
  return 'encerrado';
}

/** Origem gravada no agendamento (enum de metadata.origin.source). */
export function originSourceFromUtm(utm = {}) {
  return String(utm.source || '').toLowerCase().includes('instagram') ? 'instagram' : 'site';
}

/** Mascara telefone para log: só os 4 últimos dígitos. */
export function maskPhone(phone) {
  const d = onlyDigits(phone);
  return d ? `***${d.slice(-4)}` : '';
}
