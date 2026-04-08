// services/dailyClosingCacheService.js
/**
 * Serviço de cache para Daily Closing
 * 
 * Gerencia invalidação de snapshots quando dados financeiros mudam.
 * Isso garante que o daily-closing sempre mostre dados atualizados.
 */

import DailyClosingSnapshot from '../models/DailyClosingSnapshot.js';
import { toDateString, getDayRange, todayString } from '../utils/dateUtils.js';

/**
 * Invalida snapshot de uma data específica
 * @param {string|Date} date - Data no formato YYYY-MM-DD ou Date
 * @param {string} clinicId - ID da clínica (default: 'default')
 */
export async function invalidateDailyClosingCache(date, clinicId = 'default') {
    try {
        const dateStr = toDateString(date);
        const { start, end } = getDayRange(date);

        // Deleta usando range para pegar qualquer snapshot do dia, independente da hora
        const result = await DailyClosingSnapshot.deleteMany({
            date: { $gte: start, $lte: end },
            clinicId: clinicId || 'default'
        });

        if (result.deletedCount > 0) {
            console.log(`[DailyClosingCache] Snapshot invalidado: ${dateStr} (clinic: ${clinicId}, deletados: ${result.deletedCount})`);
        }

        return result.deletedCount;
    } catch (error) {
        console.error('[DailyClosingCache] Erro ao invalidar cache:', error);
        return 0;
    }
}

/**
 * Invalida snapshots de múltiplas datas
 * @param {string[]} dates - Array de datas (YYYY-MM-DD ou Date)
 * @param {string} clinicId - ID da clínica
 */
export async function invalidateMultipleDates(dates, clinicId = 'default') {
    try {
        // Constrói query $or com ranges para cada data
        const dateRanges = dates.map(date => {
            const { start, end } = getDayRange(date);
            return { date: { $gte: start, $lte: end } };
        });

        const result = await DailyClosingSnapshot.deleteMany({
            $or: dateRanges,
            clinicId: clinicId || 'default'
        });

        if (result.deletedCount > 0) {
            console.log(`[DailyClosingCache] ${result.deletedCount} snapshots invalidados`);
        }

        return result.deletedCount;
    } catch (error) {
        console.error('[DailyClosingCache] Erro ao invalidar caches:', error);
        return 0;
    }
}

/**
 * Invalida cache baseado na data de um pagamento
 * @param {Object} payment - Documento do Payment
 */
export async function invalidateCacheForPayment(payment) {
    if (!payment) return;

    // Extrai a data do pagamento (paidAt tem prioridade, depois paymentDate, etc)
    const paymentDate = payment.paidAt || payment.paymentDate || payment.createdAt || payment.serviceDate;
    if (!paymentDate) return;

    const clinicId = payment.clinicId || 'default';

    await invalidateDailyClosingCache(paymentDate, clinicId);
}

/**
 * Invalida cache do dia atual (útil para operações em lote)
 */
export async function invalidateTodayCache(clinicId = 'default') {
    return invalidateDailyClosingCache(todayString(), clinicId);
}

/**
 * Limpa todos os snapshots (útil para debug)
 */
export async function clearAllSnapshots() {
    try {
        const result = await DailyClosingSnapshot.deleteMany({});
        console.log(`[DailyClosingCache] Todos os snapshots deletados: ${result.deletedCount}`);
        return result.deletedCount;
    } catch (error) {
        console.error('[DailyClosingCache] Erro ao limpar snapshots:', error);
        return 0;
    }
}

export default {
    invalidateDailyClosingCache,
    invalidateMultipleDates,
    invalidateCacheForPayment,
    invalidateTodayCache,
    clearAllSnapshots
};
