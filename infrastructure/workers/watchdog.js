/**
 * Watchdog - Recuperação Automática de Eventos Stuck
 * 
 * Monitora eventos presos em 'processing' por mais de 5 minutos
 * e os reseta para 'pending' para reprocessamento.
 */

import EventStore from '../../models/EventStore.js';
import Appointment from '../../models/Appointment.js';

const STUCK_THRESHOLD_MINUTES = 5;
const MAX_RETRY_COUNT = 3;
const CHECK_INTERVAL_MS = 60000; // 1 minuto

let watchdogInterval = null;

/**
 * Verifica e recupera eventos stuck
 */
export async function checkAndRecoverStuckEvents() {
    try {
        const fiveMinutesAgo = new Date(Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000);
        
        // Buscar eventos stuck
        const stuckEvents = await EventStore.find({
            status: 'processing',
            updatedAt: { $lt: fiveMinutesAgo },
            $or: [
                { attempts: { $lt: MAX_RETRY_COUNT } },
                { attempts: { $exists: false } }
            ]
        }).limit(50);
        
        if (stuckEvents.length === 0) {
            return { checked: true, recovered: 0 };
        }
        
        console.log(`[WATCHDOG] Encontrados ${stuckEvents.length} eventos stuck`);
        
        const results = [];
        
        for (const event of stuckEvents) {
            try {
                // Liberar lock do appointment
                if (event.appointmentId) {
                    await Appointment.findByIdAndUpdate(event.appointmentId, {
                        $unset: { lock: 1 },
                        $set: { lockedAt: null }
                    });
                }
                
                // Resetar evento para pending
                event.status = 'pending';
                event.attempts = (event.attempts || 0) + 1;
                event.recoveredAt = new Date();
                await event.save();
                
                results.push({
                    eventId: event._id,
                    status: 'recovered',
                    attempts: event.attempts
                });
                
                console.log(`[WATCHDOG] Evento ${event._id} recuperado (attempts: ${event.attempts})`);
                
            } catch (err) {
                console.error(`[WATCHDOG] Erro ao recuperar evento ${event._id}:`, err.message);
                results.push({
                    eventId: event._id,
                    status: 'failed',
                    error: err.message
                });
            }
        }
        
        // Alertar se houver eventos com muitos retries
        const highRetryEvents = stuckEvents.filter(e => (e.attempts || 0) >= MAX_RETRY_COUNT);
        if (highRetryEvents.length > 0) {
            console.error(`[WATCHDOG ALERT] ${highRetryEvents.length} eventos com retry >= ${MAX_RETRY_COUNT}`);
            // TODO: Enviar alerta para Slack/email
        }
        
        return {
            checked: true,
            recovered: results.filter(r => r.status === 'recovered').length,
            failed: results.filter(r => r.status === 'failed').length,
            results
        };
        
    } catch (error) {
        console.error('[WATCHDOG] Erro na verificação:', error.message);
        return { checked: false, error: error.message };
    }
}

/**
 * Inicia o watchdog
 */
export function startWatchdog() {
    if (watchdogInterval) {
        console.log('[WATCHDOG] Já está rodando');
        return;
    }
    
    console.log('[WATCHDOG] Iniciando monitoramento...');
    
    // Primeira verificação imediata
    checkAndRecoverStuckEvents();
    
    // Verificação periódica
    watchdogInterval = setInterval(checkAndRecoverStuckEvents, CHECK_INTERVAL_MS);
    
    console.log(`[WATCHDOG] Intervalo: ${CHECK_INTERVAL_MS}ms`);
}

/**
 * Para o watchdog
 */
export function stopWatchdog() {
    if (watchdogInterval) {
        clearInterval(watchdogInterval);
        watchdogInterval = null;
        console.log('[WATCHDOG] Parado');
    }
}

/**
 * Status do watchdog
 */
export function getWatchdogStatus() {
    return {
        running: !!watchdogInterval,
        intervalMs: CHECK_INTERVAL_MS,
        stuckThresholdMinutes: STUCK_THRESHOLD_MINUTES,
        maxRetries: MAX_RETRY_COUNT
    };
}

export default {
    startWatchdog,
    stopWatchdog,
    checkAndRecoverStuckEvents,
    getWatchdogStatus
};
