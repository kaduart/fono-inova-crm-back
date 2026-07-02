// services/guideLifecycle/utils/dateUtils.js

/**
 * Utilitários de data para o ciclo de vida de guias.
 *
 * Todas as operações trabalham em UTC para garantir consistência
 * entre servidor, banco de dados (MongoDB armazena UTC) e testes.
 *
 * A camada de apresentação (frontend) é responsável por converter
 * para o fuso horário local da clínica quando necessário.
 */

export function startOfDayUTC(d) {
  const date = new Date(d);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function endOfMonthUTC(d) {
  const date = new Date(d);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  return new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999));
}

export function subDaysUTC(d, days) {
  const result = new Date(d);
  result.setUTCDate(result.getUTCDate() - days);
  return startOfDayUTC(result);
}

export function isSameDayUTC(a, b) {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

export function isAfterDayUTC(a, b) {
  const startA = startOfDayUTC(a);
  const startB = startOfDayUTC(b);
  return startA.getTime() > startB.getTime();
}

export function differenceInDaysUTC(a, b) {
  const startA = startOfDayUTC(a);
  const startB = startOfDayUTC(b);
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.ceil((startA.getTime() - startB.getTime()) / msPerDay);
}
