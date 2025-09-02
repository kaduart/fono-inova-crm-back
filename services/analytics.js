import { BetaAnalyticsDataClient } from '@google-analytics/data';
import fs from 'fs';
import path from 'path';

// Caminho absoluto para a chave JSON
const keyPath = path.resolve('./config/ga4-key.json');
const key = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));

const client = new BetaAnalyticsDataClient({
    credentials: key,
});

const propertyId = process.env.GA4_PROPERTY_ID;

// Eventos detalhados
export const getGA4Events = async (startDate = '30daysAgo', endDate = 'today') => {
    const [response] = await client.runReport({
        property: `properties/${propertyId}`,
        dimensions: [{ name: 'eventName' }],
        metrics: [{ name: 'eventCount' }],
        dateRanges: [{ startDate, endDate }],
    });

    return response.rows.map(row => ({
        action: row.dimensionValues[0]?.value || '',
        value: parseInt(row.metricValues[0]?.value || 0),
        timestamp: new Date(),
    }));
};

// Métricas gerais
export const getGA4Metrics = async (startDate = '30daysAgo', endDate = 'today') => {
    const [response] = await client.runReport({
        property: `properties/${propertyId}`,
        metrics: [
            { name: 'totalUsers' },
            { name: 'activeUsers' },
            { name: 'sessions' },
            { name: 'engagedSessions' },
            { name: 'averageSessionDuration' },
        ],
        dateRanges: [{ startDate, endDate }],
    });

    const values = response.rows[0]?.metricValues || [];

    return {
        totalUsers: parseInt(values[0]?.value || 0),
        activeUsers: parseInt(values[1]?.value || 0),
        sessions: parseInt(values[2]?.value || 0),
        engagedSessions: parseInt(values[3]?.value || 0),
        avgSessionDuration: parseFloat(values[4]?.value || 0),
    };
};
