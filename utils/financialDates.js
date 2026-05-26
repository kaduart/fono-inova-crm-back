/**
 * 📅 UTILITÁRIOS DE DATA FINANCEIRA
 *
 * Centraliza a regra de "qual data vale para quê".
 *
 * REGRAS OFICIAIS:
 *   ┌─────────────────────┬──────────────────────────────────────────────┐
 *   │ Propósito           │ Campo oficial                                │
 *   ├─────────────────────┼──────────────────────────────────────────────┤
 *   │ Caixa / DRE         │ payment.financialDate || payment.paymentDate │
 *   │ Competência clínica │ appointment.date || session.date             │
 *   │ Auditoria (quitado) │ payment.paidAt                               │
 *   │ Auditoria (doc)     │ payment.createdAt                            │
 *   └─────────────────────┴──────────────────────────────────────────────┘
 *
 * Nenhum outro arquivo deve inferir datas financeiras por conta própria.
 */

import moment from 'moment-timezone';

const TIMEZONE = 'America/Sao_Paulo';

/**
 * Retorna a data de caixa (competência financeira) de um Payment.
 * @param {Object} payment
 * @returns {Date|null}
 */
export function getCashDate(payment) {
  if (!payment) return null;
  return payment.financialDate || payment.paymentDate || null;
}

/**
 * Retorna a data de competência clínica (quando o serviço foi realizado).
 * @param {Object} session
 * @param {Object} [appointment]
 * @returns {Date|null}
 */
export function getCompetenceDate(session, appointment) {
  if (!session && !appointment) return null;
  if (appointment?.date) return new Date(appointment.date);
  if (session?.date) return new Date(session.date);
  return null;
}

/**
 * Retorna a data de auditoria operacional (quando foi quitado).
 * @param {Object} payment
 * @returns {Date|null}
 */
export function getAuditPaidDate(payment) {
  return payment?.paidAt || null;
}

/**
 * Retorna a data de auditoria técnica (criação do documento).
 * @param {Object} payment
 * @returns {Date|null}
 */
export function getAuditCreatedDate(payment) {
  return payment?.createdAt || null;
}

/**
 * Converte uma data para início do dia no timezone da clínica.
 * Útil para normalizar ranges de query.
 * @param {Date|string} d
 * @returns {moment.Moment}
 */
export function startOfDayClinic(d) {
  return moment.tz(d, TIMEZONE).startOf('day');
}

/**
 * Converte uma data para fim do dia no timezone da clínica.
 * @param {Date|string} d
 * @returns {moment.Moment}
 */
export function endOfDayClinic(d) {
  return moment.tz(d, TIMEZONE).endOf('day');
}

/**
 * Retorna o range [start, end] como Date UTC para queries MongoDB,
 * a partir de uma string YYYY-MM-DD ou Date.
 *
 * @param {Date|string} start
 * @param {Date|string} end
 * @returns {{start: Date, end: Date}}
 */
export function toUtcRange(start, end) {
  return {
    start: startOfDayClinic(start).utc().toDate(),
    end: endOfDayClinic(end).utc().toDate(),
  };
}

/**
 * Retorna o primeiro e último dia do mês no timezone da clínica,
 * convertidos para UTC (uso em queries MongoDB).
 *
 * @param {number} year
 * @param {number} month  (1-12)
 * @returns {{start: Date, end: Date}}
 */
export function monthUtcRange(year, month) {
  const start = moment.tz([year, month - 1], TIMEZONE).startOf('month').utc().toDate();
  const end = moment.tz([year, month - 1], TIMEZONE).endOf('month').utc().toDate();
  return { start, end };
}
