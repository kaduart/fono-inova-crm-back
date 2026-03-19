#!/usr/bin/env node
/**
 * 🔍 Diagnóstico completo GA4
 * Verifica tudo: credenciais, acesso, property
 */

import { BetaAnalyticsDataClient } from '@google-analytics/data';
import dotenv from 'dotenv';
import { execSync } from 'child_process';

dotenv.config();

console.log('🔍 DIAGNÓSTICO GA4 COMPLETO\n');
console.log('===========================\n');

// 1. Verificar variáveis
console.log('1️⃣ Variáveis de Ambiente:');
console.log('   GA4_PROPERTY_ID:', process.env.GA4_PROPERTY_ID || '❌ não definido');
console.log('   GA4_CLIENT_EMAIL:', process.env.GA4_CLIENT_EMAIL || '❌ não definido');
console.log('   GA4_PRIVATE_KEY: existe?', process.env.GA4_PRIVATE_KEY ? '✅ sim' : '❌ não');
console.log('');

if (!process.env.GA4_PRIVATE_KEY) {
    console.log('❌ GA4_PRIVATE_KEY não encontrada!');
    process.exit(1);
}

// Limpar chave
let privateKey = process.env.GA4_PRIVATE_KEY;
if (privateKey?.startsWith('"')) privateKey = privateKey.slice(1);
if (privateKey?.endsWith('"')) privateKey = privateKey.slice(0, -1);
if (privateKey?.startsWith('\"') && privateKey?.endsWith('\"')) privateKey = privateKey.slice(1, -1);
privateKey = privateKey?.replace(/\\\\n/g, '\n');
privateKey = privateKey?.replace(/\\n/g, '\n');

console.log('2️⃣ Análise da Chave Privada:');
console.log('   Tamanho:', privateKey.length, 'caracteres');
console.log('   Status:', privateKey.length > 1000 ? '✅ Parece completa' : '❌ Parece INCOMPLETA/Truncada');
console.log('   Tem BEGIN:', privateKey.includes('-----BEGIN PRIVATE KEY-----') ? '✅' : '❌');
console.log('   Tem END:', privateKey.includes('-----END PRIVATE KEY-----') ? '✅' : '❌');
console.log('');

if (privateKey.length < 1000) {
    console.log('⚠️  ATENÇÃO: A chave está muito curta!');
    console.log('    Chaves RSA geralmente têm 1700+ caracteres.');
    console.log('    Possíveis causas:');
    console.log('      - Chave foi truncada ao copiar/colar');
    console.log('      - Apenas parte da chave foi salva');
    console.log('      - Encoding errado (\\n vs newline real)');
    console.log('');
    console.log('📝 Conteúdo atual da chave:');
    console.log(privateKey);
    console.log('');
}

// Tentar criar cliente
console.log('3️⃣ Tentando conectar à API GA4...\n');

const credentials = {
    client_email: process.env.GA4_CLIENT_EMAIL,
    private_key: privateKey,
    type: 'service_account',
    project_id: process.env.GA4_PROJECT_ID || 'dazzling-ocean-457023-m8'
};

try {
    const client = new BetaAnalyticsDataClient({ credentials });
    console.log('   ✅ Cliente criado com sucesso');
    
    // Tentar uma chamada simples
    const propertyId = process.env.GA4_PROPERTY_ID;
    console.log('   📊 Tentando buscar métricas...');
    console.log('   Property:', `properties/${propertyId}`);
    
    const [response] = await client.runReport({
        property: `properties/${propertyId}`,
        metrics: [{ name: 'totalUsers' }],
        dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
    });
    
    console.log('   ✅ Conexão bem-sucedida!');
    console.log('   Usuários (7 dias):', response.rows?.[0]?.metricValues?.[0]?.value || 0);
    
} catch (err) {
    console.log('   ❌ ERRO na conexão:');
    console.log('   Mensagem:', err.message);
    console.log('   Código:', err.code || 'N/A');
    console.log('');
    
    if (err.message.includes('DECODER') || err.message.includes('unsupported')) {
        console.log('💡 DIAGNÓSTICO: Chave privada inválida ou mal formatada');
        console.log('   - Verifique se a chave está completa');
        console.log('   - Verifique se as quebras de linha estão corretas');
    }
    
    if (err.message.includes('permission') || err.code === 7) {
        console.log('💡 DIAGNÓSTICO: Sem permissão');
        console.log('   - A conta de serviço não tem acesso ao property');
        console.log('   - Verifique no GA4: Admin > Property Access Management');
    }
    
    if (err.message.includes('not found') || err.code === 5) {
        console.log('💡 DIAGNÓSTICO: Property não encontrado');
        console.log('   - Verifique se GA4_PROPERTY_ID está correto');
        console.log('   - Verifique se o property existe');
    }
    
    if (err.message.includes('unauthorized') || err.code === 16) {
        console.log('💡 DIAGNÓSTICO: Não autorizado');
        console.log('   - A chave pode ter sido revogada');
        console.log('   - Gere uma nova chave no Google Cloud');
    }
}

console.log('\n===========================');
console.log('Fim do diagnóstico');
