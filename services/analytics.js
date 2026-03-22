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
                    dimensions: [
                        { name: 'eventName' },
                        { name: 'date' }   // breakdown diário real
                    ],
                    metrics: [{ name: 'eventCount' }],
                    dateRanges: [{ startDate, endDate }],
                    orderBys: [{ dimension: { orderType: 'ALPHANUMERIC', dimensionName: 'date' } }],
                    limit: 10000,
                },
                { timeout }
            )
        );

        const rows = response.rows || [];
        // date do GA4 vem como 'YYYYMMDD', converter para 'YYYY-MM-DD' + meio-dia local
        const events = rows.map(row => {
            const raw = row.dimensionValues?.[1]?.value || '';
            const dateStr = raw.length === 8
                ? `${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}T12:00:00`
                : new Date().toISOString();
            return {
                action: row.dimensionValues?.[0]?.value || '',
                value: parseInt(row.metricValues?.[0]?.value || 0),
                timestamp: new Date(dateStr),
            };
        });

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
                    limit: 100,
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

// --- Buscar fontes de tráfego (sources) ---
export const getGA4Sources = async (startDate, endDate, timeout = 30000) => {
    const cacheKey = `ga4-sources-${startDate}-${endDate}`;
    const cached = analyticsCache.get(cacheKey);
    if (cached) return cached;

    try {
        console.log('🌐 Chamando GA4 Sources:', startDate, endDate);
        
        if (!credentials) {
            console.log('⚠️ GA4 não configurado, retornando sources vazios');
            return [];
        }

        const [response] = await withRetry(() =>
            client.runReport(
                {
                    property: `properties/${propertyId}`,
                    dimensions: [
                        { name: 'sessionSource' },
                        { name: 'sessionMedium' }
                    ],
                    metrics: [
                        { name: 'sessions' },
                        { name: 'totalUsers' },
                        { name: 'conversions' }
                    ],
                    dateRanges: [{ startDate, endDate }],
                    limit: 20,
                    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }]
                },
                { timeout }
            )
        );

        const rows = response.rows || [];
        const sources = rows.map(row => ({
            source: row.dimensionValues?.[0]?.value || 'direct',
            medium: row.dimensionValues?.[1]?.value || 'none',
            sessions: parseInt(row.metricValues?.[0]?.value || 0),
            users: parseInt(row.metricValues?.[1]?.value || 0),
            conversions: parseInt(row.metricValues?.[2]?.value || 0)
        }));

        console.log(`🌐 ${sources.length} sources encontradas no GA4`);
        analyticsCache.set(cacheKey, sources);
        return sources;
    } catch (err) {
        console.error('❌ Erro em getGA4Sources:', err.message);
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

// Caminhos das páginas SEO de Anápolis
const ANAPOLIS_PATHS = [
    '/fonoaudiologia-anapolis',
    '/psicologia-infantil-anapolis',
    '/terapia-ocupacional-anapolis',
    '/psicomotricidade-anapolis',
    '/teste-da-linguinha-anapolis',
    '/fisioterapia-infantil-anapolis',
    '/avaliacao-neuropsicologica-anapolis',
];

// --- Buscar páginas SEO de Anápolis com dimensionFilter (evita limite dos top 50) ---
export const getGA4AnapolisPages = async (startDate, endDate, timeout = 30000) => {
    const cacheKey = `ga4-anapolis-${startDate}-${endDate}`;
    const cached = analyticsCache.get(cacheKey);
    if (cached) return cached;

    try {
        console.log('📍 Chamando GA4 Anápolis Pages:', startDate, endDate);

        if (!credentials) {
            console.log('⚠️ GA4 não configurado, retornando páginas de Anápolis vazias');
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
                    dimensionFilter: {
                        filter: {
                            fieldName: 'pagePath',
                            inListFilter: { values: ANAPOLIS_PATHS }
                        }
                    }
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
            bounceRate: parseFloat(row.metricValues?.[3]?.value || 0) * 100,
        }));

        console.log(`📍 ${pages.length} páginas de Anápolis encontradas no GA4`);
        analyticsCache.set(cacheKey, pages);
        return pages;
    } catch (err) {
        console.error('❌ Erro em getGA4AnapolisPages:', err.message);
        return [];
    }
};

// --- Buscar páginas por lista de caminhos (dimensionFilter genérico) ---
export const getGA4PagesByPaths = async (paths, startDate, endDate, timeout = 30000) => {
    if (!paths || paths.length === 0) return [];

    const cacheKey = `ga4-paths-${paths.join(',')}-${startDate}-${endDate}`;
    const cached = analyticsCache.get(cacheKey);
    if (cached) return cached;

    try {
        if (!credentials) return [];

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
                    dimensionFilter: {
                        filter: {
                            fieldName: 'pagePath',
                            inListFilter: { values: paths }
                        }
                    }
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
            bounceRate: parseFloat(row.metricValues?.[3]?.value || 0) * 100,
        }));

        analyticsCache.set(cacheKey, pages);
        return pages;
    } catch (err) {
        console.error('❌ Erro em getGA4PagesByPaths:', err.message);
        return [];
    }
};

// --- Buscar dados em tempo real (GA4 Realtime API) ---
export const getGA4Realtime = async (timeout = 15000) => {
    const cacheKey = 'ga4-realtime';
    const cached = analyticsCache.get(cacheKey);
    if (cached) return cached;

    try {
        if (!credentials) return null;

        const [response] = await client.runRealtimeReport(
            {
                property: `properties/${propertyId}`,
                metrics: [
                    { name: 'activeUsers' },
                    { name: 'screenPageViews' },
                    { name: 'eventCount' }
                ]
            },
            { timeout }
        );

        const values = response.rows?.[0]?.metricValues || [];
        const result = {
            activeUsers: parseInt(values[0]?.value || 0),
            pageViews: parseInt(values[1]?.value || 0),
            events: parseInt(values[2]?.value || 0),
        };

        // Cache curto: 2 minutos para realtime
        analyticsCache.set(cacheKey, result, 120);
        return result;
    } catch (err) {
        console.error('❌ Erro em getGA4Realtime:', err.message);
        return null;
    }
};

// Função auxiliar para formatar eventos com data do período
export const formatEventsWithPeriodDate = (events, startDate, endDate) => {
    return events.map(event => ({
        ...event,
        // Usar a data de início do período ao invés de new Date()
        timestamp: new Date(startDate + 'T12:00:00'),
        // Adicionar info do período
        period: { startDate, endDate }
    }));
};
