// back/services/appointment/policies/appointmentReschedulePolicy.js
/**
 * Política de remarcação de agendamento (função pura — sem I/O, testável).
 *
 * Regras (ver DOMAIN_INVARIANTS.md):
 * - Appointment é canônico da agenda (ADR-002); remarcar só muda date/time.
 * - Atendimento concluído/cancelado/faltou é histórico — não remarca.
 * - Guia de convênio e liminar têm validade: a nova data não pode ultrapassá-la.
 * - Consumo de pacote é só no complete (#17): remarcar nunca mexe em sessionsDone.
 */
import { buildError } from '../commands/_helpers.js';

// Cancelado NÃO está aqui: remarcar um cancelado = reativar + mover (reaproveita o agendamento).
// O restore (restoreCanceledAppointmentCommand) devolve Session/pacote/Payment (pending) —
// ver docs/architecture/APPOINTMENT_LIFECYCLE.md.
export const REACTIVATABLE_CANCELED_STATUSES = Object.freeze(['canceled', 'cancelado', 'cancelada']);

export const isCanceledForReschedule = (status) => REACTIVATABLE_CANCELED_STATUSES.includes(status);

export const NON_RESCHEDULABLE_STATUSES = Object.freeze([
  'completed',
  'cancelled',
  'force_cancelled',
  'missed',
  'absent',
]);

const GUIDE_BLOCKING_STATUSES = ['expired', 'cancelled', 'superseded', 'closed'];

/** Extrai 'YYYY-MM-DD' de Date | string. Datas gravadas às 12:00 UTC não deslocam o dia. */
export function toDateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    // Rejeita datas impossíveis (2026-13-45, 2026-02-31) que o regex sozinho deixaria passar.
    const d = new Date(`${value}T12:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().substring(0, 10) === value ? value : null;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().substring(0, 10);
}

function formatBR(dateOnly) {
  const [y, m, d] = dateOnly.split('-');
  return `${d}/${m}/${y}`;
}

function normalizeTime(value) {
  const m = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

/**
 * @param {object} args
 * @param {object} args.appointment  documento atual (operationalStatus, date, time, billingType)
 * @param {object|null} [args.guide]    InsuranceGuide vinculada (expiresAt, status, number)
 * @param {object|null} [args.liminar]  LiminarContract vinculado (expirationDate)
 * @param {string} args.newDate  'YYYY-MM-DD'
 * @param {string} args.newTime  'HH:mm'
 * @param {string} [args.today]  'YYYY-MM-DD' (injetável em teste)
 */
export function assertRescheduleAllowed({ appointment, guide = null, liminar = null, newDate, newTime, today }) {
  const targetDate = toDateOnly(newDate);
  const targetTime = normalizeTime(newTime);

  if (!targetDate || !targetTime) {
    throw buildError('Informe data (YYYY-MM-DD) e horário (HH:mm) válidos.', 400, 'INVALID_RESCHEDULE_PAYLOAD');
  }

  const status = appointment?.operationalStatus;
  if (NON_RESCHEDULABLE_STATUSES.includes(status)) {
    throw buildError(
      'Este atendimento já foi concluído (ou teve falta/cancelamento forçado) e não pode ser remarcado.',
      422,
      'INVALID_STATUS_FOR_RESCHEDULE'
    );
  }

  const todayStr = today || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  if (targetDate < todayStr) {
    throw buildError('Não é possível remarcar para uma data no passado.', 422, 'RESCHEDULE_IN_PAST');
  }

  const currentDate = toDateOnly(appointment?.date);
  const currentTime = normalizeTime(appointment?.time);
  if (currentDate === targetDate && currentTime === targetTime) {
    throw buildError('A nova data e horário são iguais aos atuais.', 400, 'NO_CHANGE');
  }

  if (guide) {
    if (GUIDE_BLOCKING_STATUSES.includes(guide.status)) {
      throw buildError(
        `A guia${guide.number ? ` #${guide.number}` : ''} está ${guide.status} e não aceita novas datas.`,
        409,
        'GUIDE_NOT_ACTIVE_FOR_RESCHEDULE'
      );
    }
    const expires = toDateOnly(guide.expiresAt);
    if (expires && targetDate > expires) {
      throw buildError(
        `A guia${guide.number ? ` #${guide.number}` : ''} vence em ${formatBR(expires)}. Escolha uma data até esse dia.`,
        409,
        'GUIDE_EXPIRES_BEFORE_DATE'
      );
    }
  }

  if (liminar) {
    const expires = toDateOnly(liminar.expirationDate);
    if (expires && targetDate > expires) {
      throw buildError(
        `A liminar vence em ${formatBR(expires)}. Escolha uma data até esse dia.`,
        409,
        'LIMINAR_EXPIRES_BEFORE_DATE'
      );
    }
  }

  return { date: targetDate, time: targetTime };
}

export default { assertRescheduleAllowed, NON_RESCHEDULABLE_STATUSES, toDateOnly };
