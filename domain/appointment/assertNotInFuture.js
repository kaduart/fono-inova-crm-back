// back/domain/appointment/assertNotInFuture.js
/**
 * Guard: atendimento não pode ser concluído antes de acontecer.
 *
 * Origem (2026-08-07, guia 16173377): um appointment datado de 18/09 foi
 * concluído manualmente em 07/08 — 42 dias antes da sessão existir. Consumiu
 * autorização do convênio e lançou R$ 80 de produção de um atendimento que não
 * tinha acontecido. Nada no sistema impediu.
 *
 * Comparação em horário da CLÍNICA (America/Sao_Paulo), não em UTC:
 * `appointment.date` é gravado ora como meia-noite local (03:00Z), ora como
 * 12:00Z. Comparar instantes UTC crus faz uma sessão das 08:00 de hoje parecer
 * futura até as 11:00, e uma das 22:00 parecer passada. O que importa é a data
 * e a hora no fuso onde a clínica atende.
 */

import moment from 'moment-timezone';

export const CLINIC_TIMEZONE = 'America/Sao_Paulo';

/**
 * Instante em que o atendimento começa, no fuso da clínica.
 * Usa a DATA do appointment (lida no fuso da clínica) + o campo `time`.
 * Sem `time`, assume o fim do dia — um agendamento sem hora só é "passado"
 * quando o dia inteiro já passou.
 */
export function appointmentStartMoment(appointment, timezone = CLINIC_TIMEZONE) {
  const dateStr = moment.tz(appointment?.date, timezone).format('YYYY-MM-DD');
  const time = /^\d{1,2}:\d{2}$/.test(String(appointment?.time || ''))
    ? String(appointment.time).padStart(5, '0')
    : '23:59';
  return moment.tz(`${dateStr} ${time}`, 'YYYY-MM-DD HH:mm', timezone);
}

/**
 * @param {Object} appointment - { date, time }
 * @param {Date|moment} [now]
 * @returns {boolean}
 */
export function isAppointmentInFuture(appointment, now = new Date(), timezone = CLINIC_TIMEZONE) {
  if (!appointment?.date) return false;
  return appointmentStartMoment(appointment, timezone).isAfter(moment.tz(now, timezone));
}

/**
 * Lança se o atendimento ainda não começou.
 *
 * `allowFutureCompletion` NÃO é um boolean livre vindo do frontend: quem chama
 * precisa provar autorização (permissão do usuário) e registrar justificativa.
 * Ver completeSessionService.v2.js.
 *
 * @param {Object} appointment
 * @param {Object} [opts]
 * @param {boolean} [opts.allowFutureCompletion=false] - já validado pelo caller
 * @param {Date} [opts.now]
 */
export function assertNotInFuture(appointment, { allowFutureCompletion = false, now = new Date(), timezone = CLINIC_TIMEZONE } = {}) {
  if (!isAppointmentInFuture(appointment, now, timezone)) return;

  if (allowFutureCompletion) {
    console.warn('[assertNotInFuture] ⚠️ Conclusão de atendimento futuro autorizada por exceção', {
      appointmentId: appointment?._id?.toString?.(),
      date: appointment?.date,
      time: appointment?.time,
    });
    return;
  }

  const start = appointmentStartMoment(appointment, timezone);
  const err = new Error(
    `Não é possível concluir um atendimento com data futura ` +
    `(${start.format('DD/MM/YYYY [às] HH:mm')}, horário de Brasília).`
  );
  err.code = 'APPOINTMENT_IN_FUTURE';
  err.status = 422;
  err.statusCode = 422;
  err.appointmentStart = start.toISOString();
  throw err;
}

export default { assertNotInFuture, isAppointmentInFuture, appointmentStartMoment, CLINIC_TIMEZONE };
