/**
 * 🚨 Alert Service - Notificações proativas
 * 
 * Envia alertas quando:
 * - Eventos excedem retry limit
 * - Memory pressure crítica
 * - Eventos stuck por muito tempo
 * - Múltiplos eventos falhando
 * 
 * Suporta: Slack, Webhook genérico, Log (fallback)
 */

import { createContextLogger } from '../../utils/logger.js';

const log = createContextLogger('alerts', 'system');

// Configurações
const ALERT_CONFIG = {
    // Slack Webhook (opcional)
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
    
    // Webhook genérico (opcional)
    webhookUrl: process.env.ALERT_WEBHOOK_URL,
    
    // Alertas por email (placeholder para implementação futura)
    emailEnabled: process.env.ALERT_EMAIL_ENABLED === 'true',
    
    // Cooldown entre alertas similares (minutos)
    cooldownMinutes: 5,
    
    // Ambiente
    environment: process.env.NODE_ENV || 'development',
    appName: process.env.APP_NAME || 'CRM'
};

// Cache de alertas recentes (evita spam)
const recentAlerts = new Map();

/**
 * Envia alerta
 */
export async function sendAlert({ level = 'warning', type, message, details = {} }) {
    const alertKey = `${type}_${level}`;
    const now = Date.now();
    
    // 🛡️ Cooldown - evita spam de alertas
    const lastAlert = recentAlerts.get(alertKey);
    const cooldownMs = ALERT_CONFIG.cooldownMinutes * 60 * 1000;
    
    if (lastAlert && (now - lastAlert) < cooldownMs) {
        log.debug('alert_cooldown', `Alerta ${alertKey} em cooldown`, { 
            minutesSinceLast: Math.round((now - lastAlert) / 60000) 
        });
        return { sent: false, reason: 'cooldown' };
    }
    
    // Registra alerta
    recentAlerts.set(alertKey, now);
    
    // Log sempre
    log.warn(`ALERT_${level.toUpperCase()}`, message, { type, ...details });
    
    // Envia para canais configurados
    const results = await Promise.allSettled([
        sendSlackAlert({ level, type, message, details }),
        sendWebhookAlert({ level, type, message, details })
    ]);
    
    return { 
        sent: true, 
        channels: results.map((r, i) => ({
            channel: i === 0 ? 'slack' : 'webhook',
            success: r.status === 'fulfilled'
        }))
    };
}

/**
 * Alerta específico: Evento em Dead Letter (max retries)
 */
export async function alertDeadLetter({ eventId, eventType, retryCount, error, appointmentId }) {
    return sendAlert({
        level: 'critical',
        type: 'dead_letter',
        message: `🚨 Evento movido para Dead Letter após ${retryCount} tentativas`,
        details: {
            eventId,
            eventType,
            retryCount,
            error: error?.message || error,
            appointmentId,
            action: 'Investigar e reprocessar manualmente via scripts'
        }
    });
}

/**
 * Alerta específico: Memory Pressure
 */
export async function alertMemoryPressure({ heapPercent, heapUsed, heapTotal }) {
    return sendAlert({
        level: 'critical',
        type: 'memory_pressure',
        message: `🔴 Memory Pressure Crítica: ${Math.round(heapPercent * 100)}%`,
        details: {
            heapPercent: Math.round(heapPercent * 100),
            heapUsedMB: Math.round(heapUsed / 1024 / 1024),
            heapTotalMB: Math.round(heapTotal / 1024 / 1024),
            action: 'Worker será reiniciado pelo Render/PM2'
        }
    });
}

/**
 * Alerta específico: Múltiplos eventos stuck
 */
export async function alertStuckEvents({ count, oldestMinutes, events }) {
    const level = count > 10 ? 'critical' : count > 5 ? 'warning' : 'info';
    
    return sendAlert({
        level,
        type: 'stuck_events',
        message: `⏳ ${count} eventos travados há ${oldestMinutes} minutos`,
        details: {
            stuckCount: count,
            oldestMinutes,
            eventTypes: [...new Set(events.map(e => e.eventType))],
            sampleEventIds: events.slice(0, 3).map(e => e.eventId),
            action: 'Watchdog tentará recuperar automaticamente'
        }
    });
}

/**
 * Alerta específico: Worker falhou após todas as tentativas
 */
export async function alertWorkerFailed({ appointmentId, error, attemptsMade }) {
    return sendAlert({
        level: 'error',
        type: 'worker_failed',
        message: `❌ Worker falhou após ${attemptsMade} tentativas`,
        details: {
            appointmentId,
            error: error?.message || error,
            attemptsMade,
            action: 'Lock liberado - usuário pode tentar novamente'
        }
    });
}

/**
 * Envia para Slack
 */
async function sendSlackAlert({ level, type, message, details }) {
    if (!ALERT_CONFIG.slackWebhookUrl) return { skipped: true };
    
    const color = level === 'critical' ? '#FF0000' : level === 'error' ? '#FF8C00' : '#FFD700';
    const emoji = level === 'critical' ? '🚨' : level === 'error' ? '❌' : '⚠️';
    
    const payload = {
        username: `${ALERT_CONFIG.appName} Alerts`,
        icon_emoji: emoji,
        attachments: [{
            color: color,
            title: `${emoji} ${message}`,
            fields: Object.entries(details).map(([key, value]) => ({
                title: key,
                value: String(value).substring(0, 100), // Limita tamanho
                short: true
            })),
            footer: `${ALERT_CONFIG.environment} | ${new Date().toISOString()}`,
            footer_icon: 'https://platform.slack-edge.com/img/default_application_icon.png'
        }]
    };
    
    try {
        const response = await fetch(ALERT_CONFIG.slackWebhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (!response.ok) throw new Error(`Slack HTTP ${response.status}`);
        return { success: true };
    } catch (error) {
        log.error('slack_alert_failed', error.message);
        throw error;
    }
}

/**
 * Envia para Webhook genérico
 */
async function sendWebhookAlert({ level, type, message, details }) {
    if (!ALERT_CONFIG.webhookUrl) return { skipped: true };
    
    const payload = {
        app: ALERT_CONFIG.appName,
        environment: ALERT_CONFIG.environment,
        timestamp: new Date().toISOString(),
        level,
        type,
        message,
        details
    };
    
    try {
        const response = await fetch(ALERT_CONFIG.webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (!response.ok) throw new Error(`Webhook HTTP ${response.status}`);
        return { success: true };
    } catch (error) {
        log.error('webhook_alert_failed', error.message);
        throw error;
    }
}

/**
 * Limpa cache de alertas recentes (chamar periodicamente)
 */
export function cleanupAlertCache() {
    const now = Date.now();
    const maxAge = 60 * 60 * 1000; // 1 hora
    
    for (const [key, timestamp] of recentAlerts.entries()) {
        if (now - timestamp > maxAge) {
            recentAlerts.delete(key);
        }
    }
}

// Limpa cache a cada 30 minutos
setInterval(cleanupAlertCache, 30 * 60 * 1000);
