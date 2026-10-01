// utils/fixedExpenseDates.js
// Funções puras (sem I/O) das despesas fixas — fáceis de testar.
// Todo limite de mês é calculado em America/Sao_Paulo.
import moment from 'moment-timezone';

export const TIMEZONE = 'America/Sao_Paulo';

/** 'YYYY-MM' a partir de year/month (month 1-12). */
export function toCompetenceMonth(year, month) {
    return `${year}-${String(month).padStart(2, '0')}`;
}

/** Primeiro e último dia ('YYYY-MM-DD') do mês de competência. */
export function monthBounds(competenceMonth) {
    const start = moment.tz(`${competenceMonth}-01`, 'YYYY-MM-DD', TIMEZONE).startOf('month');
    return {
        start: start.format('YYYY-MM-DD'),
        end: start.clone().endOf('month').format('YYYY-MM-DD')
    };
}

/**
 * Data de vencimento da competência. Dia maior que os dias do mês
 * (ex.: 31 em setembro) vira o último dia do mês.
 */
export function computeDueDate(competenceMonth, dueDay) {
    const first = moment.tz(`${competenceMonth}-01`, 'YYYY-MM-DD', TIMEZONE);
    const day = Math.min(Math.max(Number(dueDay) || 1, 1), first.daysInMonth());
    return first.date(day).format('YYYY-MM-DD');
}

/**
 * Um modelo gera ocorrência na competência se estiver ativo e o vencimento
 * calculado cair dentro de [startDate, endDate] (endDate opcional).
 * Datas 'YYYY-MM-DD' comparam corretamente como string.
 */
export function isEligibleForMonth(model, competenceMonth) {
    if (!model || model.active === false) return false;
    const due = computeDueDate(competenceMonth, model.dueDay);
    if (model.startDate && due < model.startDate) return false;
    if (model.endDate && due > model.endDate) return false;
    return true;
}
