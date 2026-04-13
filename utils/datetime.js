/**
 * 🕐 DATETIME UTILS - Padrão V2
 * 
 * REGRAS:
 * 1. Frontend manda: date ("YYYY-MM-DD") + time ("HH:mm") separados
 * 2. Backend converte para Date com timezone BRT (-03:00)
 * 3. Banco guarda: Date (UTC internamente)
 * 4. Queries usam: RANGE ($gte, $lte) nunca igualdade
 */

/**
 * Converte date + time string para Date com timezone BRT
 * @param {string} date - "YYYY-MM-DD"
 * @param {string} time - "HH:mm"
 * @returns {Date} - Date com timezone BRT
 */
export function buildDateTime(date, time) {
  if (!date || !time) {
    throw new Error('Date e time são obrigatórios');
  }
  // Valida formato
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Formato de data inválido: ${date}. Use YYYY-MM-DD`);
  }
  if (!/^\d{2}:\d{2}$/.test(time)) {
    throw new Error(`Formato de hora inválido: ${time}. Use HH:mm`);
  }
  
  return new Date(`${date}T${time}:00-03:00`);
}

/**
 * Cria range de busca para um dia inteiro (timezone BRT)
 * @param {string} date - "YYYY-MM-DD"
 * @returns {Object} - { $gte: Date, $lte: Date }
 */
export function buildDayRange(date) {
  if (!date) {
    throw new Error('Date é obrigatório');
  }
  
  return {
    $gte: new Date(`${date}T00:00:00-03:00`),
    $lte: new Date(`${date}T23:59:59-03:00`)
  };
}

/**
 * Extrai date e time de um objeto slot
 * @param {Object} slot - { date: "YYYY-MM-DD", time: "HH:mm" }
 * @returns {Date}
 */
export function slotToDateTime(slot) {
  return buildDateTime(slot.date, slot.time);
}

/**
 * Converte array de slots para array de Dates
 * @param {Array} slots - [{ date, time }, ...]
 * @returns {Array<Date>}
 */
export function slotsToDateTimes(slots) {
  return slots.map(slotToDateTime);
}

/**
 * Formata Date para string YYYY-MM-DD
 * @param {Date} date
 * @returns {string}
 */
export function formatDateYMD(date) {
  return date.toISOString().split('T')[0];
}

/**
 * Formata Date para string HH:mm (timezone BRT)
 * @param {Date} date
 * @returns {string}
 */
export function formatTimeHM(date) {
  const options = { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false };
  return date.toLocaleTimeString('pt-BR', options);
}

/**
 * Valida se date está no formato correto
 * @param {string} date
 * @returns {boolean}
 */
export function isValidDateYMD(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date);
}

/**
 * Valida se time está no formato correto
 * @param {string} time
 * @returns {boolean}
 */
export function isValidTimeHM(time) {
  return /^\d{2}:\d{2}$/.test(time);
}
