import { BetaAnalyticsDataClient } from '@google-analytics/data';
import fs from 'fs';
import path from 'path';

// --- Lendo a chave GA4 ---
const keyPath = path.resolve(process.env.GA4_KEY_PATH || './config/ga4-key.json');
console.log('GA4_KEY_PATH usado:', keyPath);

let key;
try {
    if (process.env.GA4_KEY_JSON) {
        key = JSON.parse(process.env.GA4_KEY_JSON);
    } else {
        // fallback local para dev
        const keyPath = path.resolve('./config/ga4-key.json');
        key = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));
    }
} catch (err) {
    console.error('Erro ao carregar chave GA4:', err);
    throw err;
}


// --- Inicializando client ---
const client = new BetaAnalyticsDataClient({
    credentials: key,
});

const propertyId = process.env.GA4_PROPERTY_ID;
if (!propertyId) throw new Error('GA4_PROPERTY_ID não definido');
console.log('GA4_PROPERTY_ID:', propertyId);

// --- Função para buscar eventos detalhados ---
export const getGA4Events = async (startDate, endDate, timeout = 120000) => {
    try {
        console.log('Chamando GA4 Events:', startDate, endDate);

        const [response] = await client.runReport(
            {
                property: `properties/${propertyId}`,
                dimensions: [{ name: 'eventName' }],
                metrics: [{ name: 'eventCount' }],
                dateRanges: [{ startDate, endDate }],
            },
            { timeout }
        );

        return response.rows.map(row => ({
            action: row.dimensionValues[0]?.value || '',
            value: parseInt(row.metricValues[0]?.value || 0),
            timestamp: new Date(),
        }));
    } catch (err) {
        console.error('Erro em getGA4Events:', err);
        throw err;
    }
};

// --- Função para buscar métricas gerais ---
export const getGA4Metrics = async (startDate, endDate, timeout = 120000) => {
    try {
        console.log('Chamando GA4 Metrics:', startDate, endDate);

        const [response] = await client.runReport(
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
        );

        const values = response.rows[0]?.metricValues || [];

        return {
            totalUsers: parseInt(values[0]?.value || 0),
            activeUsers: parseInt(values[1]?.value || 0),
            sessions: parseInt(values[2]?.value || 0),
            engagedSessions: parseInt(values[3]?.value || 0),
            avgSessionDuration: parseFloat(values[4]?.value || 0),
        };
    } catch (err) {
        console.error('Erro em getGA4Metrics:', err);
        throw err;
    }
};
