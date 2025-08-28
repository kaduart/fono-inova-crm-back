import { BetaAnalyticsDataClient } from '@google-analytics/data';

const client = new BetaAnalyticsDataClient({
    credentials: {
        client_email: process.env.GA4_CLIENT_EMAIL,
        private_key: process.env.GA4_PRIVATE_KEY.replace(/\\n/g, '\n'),
    },
});

const propertyId = process.env.GA4_PROPERTY_ID;

export const getGA4Events = async () => {
    const [response] = await client.runReport({
        property: `properties/${propertyId}`,
        dimensions: [{ name: 'eventName' }, { name: 'eventLabel' }],
        metrics: [{ name: 'eventCount' }],
        dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
    });

    // transformar pro formato esperado
    const events = response.rows.map(row => ({
        action: row.dimensionValues[0]?.value || '',
        label: row.dimensionValues[1]?.value || '',
        value: row.metricValues[0]?.value || 0,
        timestamp: new Date(), // GA4 não retorna timestamp exato nesse endpoint
    }));

    return events;
};
