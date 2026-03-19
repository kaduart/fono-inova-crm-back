import { BetaAnalyticsDataClient } from '@google-analytics/data';
import fs from 'fs';
import path from 'path';
import NodeCache from 'node-cache';

// Cache em memória (1 hora)
const analyticsCache = new NodeCache({ stdTTL: 3600 });

// --- Lendo chave GA4 ---
// Opção 1: Variável GA4_KEY_JSON (JSON completo)
// Opção 2: Arquivo JSON (./config/ga4-key.json)
// Opção 3: Variáveis separadas GA4_CLIENT_EMAIL + GA4_PRIVATE_KEY

let credentials;

// Opção 1: GA4_KEY_JSON
if (process.env.GA4_KEY_JSON) {
    try {
        credentials = JSON.parse(process.env.GA4_KEY_JSON);
        console.log('✅ GA4: Usando GA4_KEY_JSON');
    } catch (err) {
        console.error('❌ Erro ao parse GA4_KEY_JSON:', err.message);
    }
}

// Opção 2: Arquivo JSON
if (!credentials) {
    const keyPath = path.resolve(process.env.GA4_KEY_PATH || './config/ga4-key.json');
    try {
        if (fs.existsSync(keyPath)) {
            credentials = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));
            console.log('✅ GA4: Usando arquivo', keyPath);
        }
    } catch (err) {
        console.warn('⚠️ Arquivo GA4 não encontrado ou inválido:', keyPath);
    }
}

// Opção 3: Variáveis separadas (como no .env atual)
if (!credentials && process.env.GA4_CLIENT_EMAIL && process.env.GA4_PRIVATE_KEY) {
    credentials = {
        client_email: process.env.GA4_CLIENT_EMAIL,
        private_key: process.env.GA4_PRIVATE_KEY.replace(/\\n/g, '\n'), // Remove escaping
        type: 'service_account',
        project_id: process.env.GA4_PROJECT_ID || 'dazzling-ocean-457023-m8'
    };
    console.log('✅ GA4: Usando GA4_CLIENT_EMAIL + GA4_PRIVATE_KEY');
}

if (!credentials) {
    console.error('❌ Nenhuma credencial GA4 encontrada!');
    console.error('   Configure uma das opções:');
    console.error('   - GA4_KEY_JSON (variável com JSON completo)');
    console.error('   - GA4_KEY_PATH (caminho para arquivo JSON)');
    console.error('   - GA4_CLIENT_EMAIL + GA4_PRIVATE_KEY (separadas)');
}

// --- Inicializando client ---
let client;
if (credentials) {
    client = new BetaAnalyticsDataClient({ credentials });
    console.log('✅ GA4 Client inicializado');
} else {
    console.warn('⚠️ GA4 Client não inicializado - faltam credenciais');
    // Client dummy para não quebrar
    client = {
        runReport: async () => {
            throw new Error('GA4 não configurado');
        }
    };
}

const propertyId = process.env.GA4_PROPERTY_ID;
if (!propertyId) {
    console.warn('⚠️ GA4_PROPERTY_ID não definido');
} else {
    console.log('✅ GA4_PROPERTY_ID:', propertyId);
}

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

// Dados vazios quando não há GA4 configurado
function getEmptyEvents() {
    return [];
}

// --- Buscar eventos detalhados ---
export const getGA4Events = async (startDate, endDate, timeout = 30000) => {
    const cacheKey = `ga4-events-${startDate}-${endDate}`;
    const cached = analyticsCache.get(cacheKey);
    if (cached) {
        console.log('♻️ Retornando eventos do cache');
        return cached;
    }

    try {
        console.log('📊 Chamando GA4 Events:', startDate, endDate);

        // Se não tiver credenciais GA4 configuradas, retorna array vazio
        if (!credentials) {
            console.log('⚠️ GA4 não configurado, retornando eventos vazios');
            return [];
        }

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
        // Retorna array vazio em caso de erro
        return [];
    }
};

// Retornar métricas vazias quando não há GA4 configurado
function getEmptyMetrics() {
    return {
        totalUsers: 0,
        activeUsers: 0,
        sessions: 0,
        engagedSessions: 0,
        avgSessionDuration: 0,
        pageViews: 0,
        bounceRate: 0,
        conversions: 0,
        eventCount: 0,
    };
}

// --- Buscar dados de páginas ---
export const getGA4Pages = async (startDate, endDate, timeout = 30000) => {
    const cacheKey = `ga4-pages-${startDate}-${endDate}`;
    const cached = analyticsCache.get(cacheKey);
    if (cached) {
        console.log('♻️ Retornando páginas do cache');
        return cached;
    }

    try {
        console.log('📄 Chamando GA4 Pages:', startDate, endDate);

        if (!credentials) {
            console.log('⚠️ GA4 não configurado, retornando páginas vazias');
            return [];
        }

        const [response] = await withRetry(() =>
            client.runReport(
                {
                    property: `properties/${propertyId}`,
                    dimensions: [
                        { name: 'pageTitle' },
                        { name: 'pagePath' }
                    ],
                    metrics: [
                        { name: 'screenPageViews' },
                        { name: 'totalUsers' },
                        { name: 'userEngagementDuration' },
                        { name: 'bounceRate' }
                    ],
                    dateRanges: [{ startDate, endDate }],
                    limit: 50,
                    orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }]
                },
                { timeout }
            )
        );

        const rows = response.rows || [];
        const pages = rows.map(row => ({
            title: row.dimensionValues?.[0]?.value || '',
            path: row.dimensionValues?.[1]?.value || '',
            views: parseInt(row.metricValues?.[0]?.value || 0),
            users: parseInt(row.metricValues?.[1]?.value || 0),
            avgEngagementTime: parseFloat(row.metricValues?.[2]?.value || 0),
            bounceRate: parseFloat(row.metricValues?.[3]?.value || 0) * 100, // Converter para %
        }));

        console.log(`📄 ${pages.length} páginas encontradas no GA4`);
        analyticsCache.set(cacheKey, pages);
        return pages;
    } catch (err) {
        console.error('❌ Erro em getGA4Pages:', err.message);
        return [];
    }
};

// --- Buscar métricas gerais ---
export const getGA4Metrics = async (startDate, endDate, timeout = 30000) => {
    const cacheKey = `ga4-metrics-${startDate}-${endDate}`;
    const cached = analyticsCache.get(cacheKey);
    if (cached) return cached;

    try {
        console.log('📈 Chamando GA4 Metrics:', startDate, endDate);
        
        // Se não tiver credenciais GA4 configuradas, retorna métricas vazias
        if (!credentials) {
            console.log('⚠️ GA4 não configurado, retornando métricas vazias');
            return getEmptyMetrics();
        }

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
                        { name: 'screenPageViews' },
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
            pageViews: parseInt(values[5]?.value || 0),
        };

        analyticsCache.set(cacheKey, metrics);
        return metrics;
    } catch (err) {
        console.error('❌ Erro em getGA4Metrics:', err.message);
        return getEmptyMetrics();
    }
};
