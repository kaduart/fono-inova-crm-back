/**
 * 🗓️ FERIADOS NACIONAIS BRASIL
 * 
 * Usa calculador dinâmico para gerar feriados automaticamente.
 * Não precisa atualizar manualmente - calcula Páscoa, Corpus Christi etc.
 */

import { 
  generateHolidaysForYear, 
  generateHolidaysForRange,
  isNationalHoliday as isHolidayDynamic,
  getHolidaysWithNames,
  NATIONAL_HOLIDAYS_DYNAMIC 
} from './feriadosBR-dynamic.js';

// Exporta feriados pré-calculados (2024-2027)
export const NATIONAL_HOLIDAYS = NATIONAL_HOLIDAYS_DYNAMIC;

/**
 * Verifica se uma data é feriado nacional
 * @param {Date|string} date - Data a verificar
 * @returns {boolean}
 */
export function isNationalHoliday(date) {
  return isHolidayDynamic(date);
}

/**
 * Gera feriados para um ano específico
 * @param {number} year - Ano
 * @returns {string[]} - Array de datas YYYY-MM-DD
 */
export function getHolidaysForYear(year) {
  return generateHolidaysForYear(year);
}

/**
 * Lista feriados com nomes
 * @param {number} year - Ano
 * @returns {Array<{date: string, name: string}>}
 */
export function listHolidays(year = new Date().getFullYear()) {
  return getHolidaysWithNames(year);
}

export default {
  NATIONAL_HOLIDAYS,
  isNationalHoliday,
  getHolidaysForYear,
  listHolidays,
};
