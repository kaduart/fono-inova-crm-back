#!/usr/bin/env node
/**
 * 🧪 Teste real da API GA4
 * Chama a API de verdade e mostra o que ela retorna
 */

import { BetaAnalyticsDataClient } from '@google-analytics/data';
import dotenv from 'dotenv';

dotenv.config();

const propertyId = process.env.GA4_PROPERTY_ID;

// Configurar credenciais
let privateKey = process.env.GA4_PRIVATE_KEY;

// Limpar formatação do .env
// Remove aspas externas se existirem
if (privateKey?.startsWith('"')) privateKey = privateKey.slice(1);
if (privateKey?.endsWith('"')) privateKey = privateKey.slice(0, -1);

// Remove aspas escapadas internas se existirem
if (privateKey?.startsWith('\"') && privateKey?.endsWith('\"')) {
    privateKey = privateKey.slice(1, -1);
}

// Converte \\n para \n (double escaped no env)
privateKey = privateKey?.replace(/\\\\n/g, '\n');
// Converte \n restantes para newlines
privateKey = privateKey?.replace(/\\n/g, '\n');

const credentials = {
    client_email: process.env.GA4_CLIENT_EMAIL,
    private_key: privateKey,
    type: 'service_account',
    project_id: process.env.GA4_PROJECT_ID || 'dazzling-ocean-457023-m8'
};

console.log('🔐 Debug chave privada:');
console.log('  Tamanho:', privateKey?.length);
console.log('  Início:', privateKey?.substring(0, 40));
console.log('  Fim:', privateKey?.substring(privateKey.length - 40));
console.log('  Tem newlines?', privateKey?.includes('\n'));
console.log('');

console.log('🔑 Credenciais:');
console.log('  Email:', credentials.client_email);
console.log('  Property ID:', propertyId);
console.log('');

const client = new BetaAnalyticsDataClient({ credentials });

// Datas: últimos 7 dias
const endDate = new Date();
const startDate = new Date();
startDate.setDate(endDate.getDate() - 7);

const startDateStr = startDate.toISOString().split('T')[0];
const endDateStr = endDate.toISOString().split('T')[0];

console.log('📅 Período:', startDateStr, 'até', endDateStr);
console.log('');

async function testGA4() {
    try {
        // Test 1: Métricas gerais
        console.log('📊 TESTE 1: Métricas Gerais');
        console.log('-----------------------------');
        const [metricResponse] = await client.runReport({
            property: `properties/${propertyId}`,
            metrics: [
                { name: 'totalUsers' },
                { name: 'activeUsers' },
                { name: 'sessions' },
                { name: 'engagedSessions' },
                { name: 'averageSessionDuration' },
                { name: 'screenPageViews' },
                { name: 'bounceRate' },
            ],
            dateRanges: [{ startDate: startDateStr, endDate: endDateStr }],
        });

        console.log('✅ Resposta recebida!');
        console.log('Rows:', metricResponse.rows?.length || 0);
        
        if (metricResponse.rows && metricResponse.rows.length > 0) {
            const values = metricResponse.rows[0].metricValues;
            console.log('\nValores:');
            console.log('  totalUsers:', values[0]?.value || 0);
            console.log('  activeUsers:', values[1]?.value || 0);
            console.log('  sessions:', values[2]?.value || 0);
            console.log('  engagedSessions:', values[3]?.value || 0);
            console.log('  avgSessionDuration:', values[4]?.value || 0);
            console.log('  screenPageViews:', values[5]?.value || 0);
            console.log('  bounceRate:', values[6]?.value || 0);
        } else {
            console.log('❌ Nenhuma linha retornada! Dados vazios.');
        }

        // Test 2: Páginas
        console.log('\n\n📄 TESTE 2: Páginas (Top 10)');
        console.log('-----------------------------');
        const [pagesResponse] = await client.runReport({
            property: `properties/${propertyId}`,
            dimensions: [
                { name: 'pageTitle' },
                { name: 'pagePath' }
            ],
            metrics: [
                { name: 'screenPageViews' },
                { name: 'totalUsers' },
                { name: 'bounceRate' }
            ],
            dateRanges: [{ startDate: startDateStr, endDate: endDateStr }],
            limit: 10,
            orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }]
        });

        console.log('✅ Resposta recebida!');
        console.log('Rows:', pagesResponse.rows?.length || 0);

        if (pagesResponse.rows && pagesResponse.rows.rows > 0) {
            console.log('\nTop páginas:');
            pagesResponse.rows.forEach((row, idx) => {
                const title = row.dimensionValues[0]?.value;
                const path = row.dimensionValues[1]?.value;
                const views = row.metricValues[0]?.value;
                const users = row.metricValues[1]?.value;
                const bounce = row.metricValues[2]?.value;
                console.log(`  ${idx + 1}. ${title} (${path})`);
                console.log(`     Views: ${views}, Users: ${users}, Bounce: ${bounce}%`);
            });
        } else {
            console.log('❌ Nenhuma página retornada!');
        }

        // Test 3: Eventos
        console.log('\n\n📈 TESTE 3: Eventos');
        console.log('-----------------------------');
        const [eventsResponse] = await client.runReport({
            property: `properties/${propertyId}`,
            dimensions: [{ name: 'eventName' }],
            metrics: [{ name: 'eventCount' }],
            dateRanges: [{ startDate: startDateStr, endDate: endDateStr }],
            limit: 10,
            orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }]
        });

        console.log('✅ Resposta recebida!');
        console.log('Rows:', eventsResponse.rows?.length || 0);

        if (eventsResponse.rows && eventsResponse.rows.length > 0) {
            console.log('\nTop eventos:');
            eventsResponse.rows.forEach((row, idx) => {
                const eventName = row.dimensionValues[0]?.value;
                const count = row.metricValues[0]?.value;
                console.log(`  ${idx + 1}. ${eventName}: ${count}`);
            });
        } else {
            console.log('❌ Nenhum evento retornado!');
        }

        console.log('\n✅ Testes concluídos!');

    } catch (err) {
        console.error('\n❌ ERRO NA API GA4:');
        console.error(err.message);
        if (err.code) console.error('Código:', err.code);
        if (err.details) console.error('Detalhes:', err.details);
    }
}

testGA4();
