import { BetaAnalyticsDataClient } from '@google-analytics/data';
import fs from 'fs';
import path from 'path';

// --- Lendo a chave GA4 ---
const keyPath = path.resolve(process.env.GA4_KEY_PATH || './config/ga4-key.json');
console.log('GA4_KEY_PATH usado:', keyPath);

let key;
try {
  key = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));
} catch (err) {
  console.error('Erro ao ler GA4_KEY_PATH:', err);
  throw err;
}

// --- Inicializando client ---
const client = new BetaAnalyticsDataClient({
  credentials: key,
});

// --- Defina seu GA4 numeric Property ID aqui ---
const propertyId = process.env.GA4_PROPERTY_ID || '123456789'; // substitua pelo seu ID real
if (!propertyId) throw new Error('GA4_PROPERTY_ID não definido');
console.log('GA4_PROPERTY_ID:', propertyId);

// --- Função para buscar eventos detalhados ---
const getGA4Events = async (startDate, endDate) => {
  try {
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
  } catch (err) {
    console.error('Erro em getGA4Events:', err);
    throw err;
  }
};

// --- Função para buscar métricas gerais ---
const getGA4Metrics = async (startDate, endDate) => {
  try {
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
  } catch (err) {
    console.error('Erro em getGA4Metrics:', err);
    throw err;
  }
};

// --- Script de teste ---
(async () => {
  const startDate = '2025-08-01';
  const endDate = '2025-08-31';

  try {
    console.log('Buscando eventos GA4...');
    const events = await getGA4Events(startDate, endDate);
    events.forEach((e, i) => {
      console.log(`${i + 1}. Evento: ${e.action}, Count: ${e.value}`);
    });

    console.log('\nBuscando métricas GA4...');
    const metrics = await getGA4Metrics(startDate, endDate);
    console.log(metrics);
  } catch (err) {
    console.error('Erro teste GA4:', err);
  }
})();
