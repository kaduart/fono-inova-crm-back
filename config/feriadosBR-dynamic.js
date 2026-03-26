/**
 * 🗓️ FERIADOS NACIONAIS BRASIL - CALCULADOR DINÂMICO
 * 
 * Calcula feriados móveis automaticamente para qualquer ano.
 * Baseado no algoritmo de cálculo da Páscoa (Método de Meeus/Jones/Butcher)
 */

/**
 * Calcula a data da Páscoa para um ano específico
 * Algoritmo de Meeus/Jones/Butcher
 * @param {number} year - Ano
 * @returns {Date} - Data da Páscoa
 */
function calculateEaster(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  
  return new Date(year, month, day);
}

/**
 * Adiciona dias a uma data
 * @param {Date} date - Data base
 * @param {number} days - Dias a adicionar
 * @returns {Date} - Nova data
 */
function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/**
 * Formata data como YYYY-MM-DD
 * @param {Date} date - Data
 * @returns {string} - Data formatada
 */
function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Gera todos os feriados nacionais para um ano específico
 * @param {number} year - Ano
 * @returns {string[]} - Array de datas YYYY-MM-DD
 */
export function generateHolidaysForYear(year) {
  const easter = calculateEaster(year);
  
  const holidays = [
    // Feriados fixos
    `${year}-01-01`, // Confraternização Universal
    `${year}-04-21`, // Tiradentes
    `${year}-05-01`, // Dia do Trabalho
    `${year}-09-07`, // Independência do Brasil
    `${year}-10-12`, // Nossa Senhora Aparecida
    `${year}-11-02`, // Finados
    `${year}-11-15`, // Proclamação da República
    `${year}-12-25`, // Natal
    
    // Feriados móveis (baseados na Páscoa)
    formatDate(addDays(easter, -48)), // Carnaval (terça) - opcional
    formatDate(addDays(easter, -47)), // Quarta-feira de cinzas - não é feriado nacional
    formatDate(addDays(easter, -2)),  // Sexta-feira Santa
    formatDate(addDays(easter, 60)),  // Corpus Christi
  ];
  
  // Remove duplicatas (caso algum feriado móvel coincida com fixo)
  return [...new Set(holidays)].sort();
}

/**
 * Gera feriados para um range de anos
 * @param {number} startYear - Ano inicial
 * @param {number} endYear - Ano final
 * @returns {string[]} - Array de datas YYYY-MM-DD
 */
export function generateHolidaysForRange(startYear, endYear) {
  const allHolidays = [];
  
  for (let year = startYear; year <= endYear; year++) {
    allHolidays.push(...generateHolidaysForYear(year));
  }
  
  return [...new Set(allHolidays)].sort();
}

/**
 * Verifica se uma data é feriado nacional
 * @param {Date|string} date - Data a verificar
 * @param {number} currentYear - Ano de referência (opcional)
 * @returns {boolean}
 */
export function isNationalHoliday(date, currentYear = new Date().getFullYear()) {
  const dateStr = typeof date === "string" 
    ? date.split("T")[0] 
    : formatDate(date);
  
  // Gera feriados para o ano da data
  const year = typeof date === "string" 
    ? parseInt(date.split("-")[0]) 
    : date.getFullYear();
  
  const holidays = generateHolidaysForYear(year);
  return holidays.includes(dateStr);
}

/**
 * Lista todos os feriados com nomes
 * @param {number} year - Ano
 * @returns {Array<{date: string, name: string}>}
 */
export function getHolidaysWithNames(year) {
  const easter = calculateEaster(year);
  
  return [
    { date: `${year}-01-01`, name: "Confraternização Universal" },
    { date: formatDate(addDays(easter, -48)), name: "Carnaval" },
    { date: formatDate(addDays(easter, -2)), name: "Sexta-feira Santa" },
    { date: `${year}-04-21`, name: "Tiradentes" },
    { date: `${year}-05-01`, name: "Dia do Trabalho" },
    { date: formatDate(addDays(easter, 60)), name: "Corpus Christi" },
    { date: `${year}-09-07`, name: "Independência do Brasil" },
    { date: `${year}-10-12`, name: "Nossa Senhora Aparecida" },
    { date: `${year}-11-02`, name: "Finados" },
    { date: `${year}-11-15`, name: "Proclamação da República" },
    { date: `${year}-12-25`, name: "Natal" },
  ].sort((a, b) => a.date.localeCompare(b.date));
}

// Gera feriados para 2024, 2025, 2026 automaticamente
export const NATIONAL_HOLIDAYS_DYNAMIC = generateHolidaysForRange(2024, 2027);

export default {
  generateHolidaysForYear,
  generateHolidaysForRange,
  isNationalHoliday,
  getHolidaysWithNames,
  NATIONAL_HOLIDAYS_DYNAMIC,
};
