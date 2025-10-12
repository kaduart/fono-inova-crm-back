import { BetaAnalyticsDataClient } from '@google-analytics/data';
import fs from 'fs';
import path from 'path';
import NodeCache from 'node-cache';

// Cache em memória (1 hora)
const analyticsCache = new NodeCache({ stdTTL: 3600 });

// --- Lendo chave GA4 ---
const keyPath = path.resolve(process.env.GA4_KEY_PATH || './config/ga4-key.json');
console.log('GA4_KEY_PATH usado:', keyPath);

let key;
try {
    if (process.env.GA4_KEY_JSON) {
        key = JSON.parse(process.env.GA4_KEY_JSON);
    } else {
        key = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));
    }
} catch (err) {
    console.error('❌ Erro ao carregar chave GA4:', err);
    throw err;
}

// --- Inicializando client ---
const client = new BetaAnalyticsDataClient({ credentials: key });

const propertyId = process.env.GA4_PROPERTY_ID;
if (!propertyId) throw new Error('GA4_PROPERTY_ID não definido');
console.log('GA4_PROPERTY_ID:', propertyId);

// --- Função auxiliar para retry ---
async function withRetry(fn, retries = 2, delay = 2000) {
    try {
        return await fn();
    } catch (err) {
        if (retries > 0) {
            console.warn(`⚠️ Erro GA4, tentando novamente (${retries} restantes)...`);
            await new Promise(r => setTimeout(r, delay));
            return withRetry(fn, retries - 1, delay * 1.5);
        }
        throw err;
    }
}

// --- Buscar eventos detalhados ---
export const getGA4Events = async (startDate, endDate, timeout = 30000) => {
    const cacheKey = `ga4-events-${startDate}-${endDate}`;
    const cached = analyticsCache.get(cacheKey);
    if (cached) return cached;

    try {
        console.log('📊 Chamando GA4 Events:', startDate, endDate);

        const [response] = await withRetry(() =>
            client.runReport(
                {
                    property: `properties/${propertyId}`,
                    dimensions: [{ name: 'eventName' }],
                    metrics: [{ name: 'eventCount' }],
                    dateRanges: [{ startDate, endDate }],
                },
                { timeout }
            )
        );

        const rows = response.rows || [];
        const events = rows.map(row => ({
            action: row.dimensionValues?.[0]?.value || '',
            value: parseInt(row.metricValues?.[0]?.value || 0),
            timestamp: new Date(),
        }));

        analyticsCache.set(cacheKey, events);
        return events;
    } catch (err) {
        console.error('❌ Erro em getGA4Events:', err.message);
        return []; // fallback seguro
    }
};

// --- Buscar métricas gerais ---
export const getGA4Metrics = async (startDate, endDate, timeout = 30000) => {
    const cacheKey = `ga4-metrics-${startDate}-${endDate}`;
    const cached = analyticsCache.get(cacheKey);
    if (cached) return cached;

    try {
        console.log('📈 Chamando GA4 Metrics:', startDate, endDate);

        const [response] = await withRetry(() =>
            client.runReport(
                {
                    property: `properties/${propertyId}`,
                    metrics: [
                        { name: 'totalUsers' },
                        { name: 'activeUsers' },
                        { name: 'sessions' },
                        { name: 'engagedSessions' },
                        { name: 'averageSessionDuration' },
                    ],
                    dateRanges: [{ startDate, endDate }],
                },
                { timeout }
            )
        );

        const values = response.rows?.[0]?.metricValues || [];

        const metrics = {
            totalUsers: parseInt(values[0]?.value || 0),
            activeUsers: parseInt(values[1]?.value || 0),
            sessions: parseInt(values[2]?.value || 0),
            engagedSessions: parseInt(values[3]?.value || 0),
            avgSessionDuration: parseFloat(values[4]?.value || 0),
        };

        analyticsCache.set(cacheKey, metrics);
        return metrics;
    } catch (err) {
        console.error('❌ Erro em getGA4Metrics:', err.message);
        return {
            totalUsers: 0,
            activeUsers: 0,
            sessions: 0,
            engagedSessions: 0,
            avgSessionDuration: 0,
        };
    }
};
