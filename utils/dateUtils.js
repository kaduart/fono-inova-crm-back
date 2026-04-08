// utils/dateUtils.js
/**
 * Utilitários de data seguros para o timezone America/Sao_Paulo
 * 
 * TODAS as datas no sistema devem usar estas funções para evitar
 * bugs de timezone e inconsistências entre string/Date.
 */

import moment from 'moment-timezone';

const TIMEZONE = 'America/Sao_Paulo';

/**
 * Converte qualquer formato de data para string YYYY-MM-DD no timezone Brasil
 * @param {string|Date} date - Data em qualquer formato
 * @returns {string} Data no formato YYYY-MM-DD
 */
export function toDateString(date) {
    if (!date) return moment.tz(TIMEZONE).format('YYYY-MM-DD');
    
    if (typeof date === 'string' && date.match(/^\d{4}-\d{2}-\d{2}$/)) {
        return date; // Já está no formato correto
    }
    
    return moment.tz(date, TIMEZONE).format('YYYY-MM-DD');
}

/**
 * Cria um Date object para meio-dia UTC de uma data específica
 * Isso evita problemas de timezone ao salvar no MongoDB
 * @param {string|Date} date - Data (YYYY-MM-DD ou Date)
 * @returns {Date} Date object para 12:00 UTC do dia especificado
 */
export function toMiddayUTC(date) {
    const dateStr = toDateString(date);
    const [ano, mes, dia] = dateStr.split('-').map(Number);
    return new Date(Date.UTC(ano, mes - 1, dia, 12, 0, 0));
}

/**
 * Retorna o início do dia (00:00:00.000) no timezone Brasil, convertido para Date UTC
 * @param {string|Date} date - Data
 * @returns {Date} Início do dia em UTC
 */
export function startOfDay(date) {
    const dateStr = toDateString(date);
    const [ano, mes, dia] = dateStr.split('-').map(Number);
    // Cria um Date que representa 00:00 no timezone Brasil
    // Mas como o construtor Date assume UTC, precisamos ajustar
    const d = new Date(Date.UTC(ano, mes - 1, dia, 0, 0, 0));
    // Ajusta para o timezone Brasil (UTC-3)
    d.setHours(d.getHours() + 3);
    return d;
}

/**
 * Retorna o fim do dia (23:59:59.999) no timezone Brasil, convertido para Date UTC
 * @param {string|Date} date - Data
 * @returns {Date} Fim do dia em UTC
 */
export function endOfDay(date) {
    const dateStr = toDateString(date);
    const [ano, mes, dia] = dateStr.split('-').map(Number);
    const d = new Date(Date.UTC(ano, mes - 1, dia, 23, 59, 59, 999));
    d.setHours(d.getHours() + 3);
    return d;
}

/**
 * Verifica se uma data é "hoje" no timezone Brasil
 * @param {string|Date} date - Data a verificar
 * @returns {boolean} true se for hoje
 */
export function isToday(date) {
    const dateStr = toDateString(date);
    const todayStr = moment.tz(TIMEZONE).format('YYYY-MM-DD');
    return dateStr === todayStr;
}

/**
 * Retorna a data de hoje como string YYYY-MM-DD no timezone Brasil
 * @returns {string} Data de hoje
 */
export function todayString() {
    return moment.tz(TIMEZONE).format('YYYY-MM-DD');
}

/**
 * Retorna o range de uma data específica (início e fim do dia)
 * Útil para queries MongoDB
 * @param {string|Date} date - Data
 * @returns {{start: Date, end: Date}} Objeto com start e end do dia
 */
export function getDayRange(date) {
    return {
        start: startOfDay(date),
        end: endOfDay(date)
    };
}

/**
 * Busca snapshot usando range de data (mais seguro que igualdade exata)
 * @param {mongoose.Model} model - Modelo Mongoose
 * @param {string|Date} date - Data
 * @param {string} clinicId - ID da clínica
 * @returns {Promise<Object|null>} Documento encontrado ou null
 */
export async function findSnapshotByDate(model, date, clinicId = 'default') {
    const { start, end } = getDayRange(date);
    
    return await model.findOne({
        date: { $gte: start, $lte: end },
        clinicId: clinicId || 'default'
    }).lean();
}

/**
 * Deleta snapshots de uma data específica
 * @param {mongoose.Model} model - Modelo Mongoose
 * @param {string|Date} date - Data
 * @param {string} clinicId - ID da clínica
 * @returns {Promise<Object>} Resultado da deleção
 */
export async function deleteSnapshotByDate(model, date, clinicId = 'default') {
    const { start, end } = getDayRange(date);
    
    return await model.deleteMany({
        date: { $gte: start, $lte: end },
        clinicId: clinicId || 'default'
    });
}

export default {
    toDateString,
    toMiddayUTC,
    startOfDay,
    endOfDay,
    isToday,
    todayString,
    getDayRange,
    findSnapshotByDate,
    deleteSnapshotByDate
};
