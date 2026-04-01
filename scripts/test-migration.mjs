#!/usr/bin/env node
/**
 * Teste de Migração - Validação dos 3 cenários
 * 
 * 1. V2 funcionando (snapshot)
 * 2. Fallback para legado (simulado)
 * 3. Métricas de performance
 */

const API_BASE = process.env.API_URL || 'http://localhost:5000/api';
const TEST_DATE = '2026-03-31'; // Data que tem snapshot

console.log('🧪 TESTE DE MIGRAÇÃO - Totals V2\n');
console.log('=' .repeat(60));
console.log(`Data de teste: ${TEST_DATE}`);

async function test(endpoint, label) {
    const start = Date.now();
    try {
        const res = await fetch(`${API_BASE}${endpoint}`);
        const duration = Date.now() - start;
        const data = await res.json().catch(() => null);
        
        return {
            success: res.ok,
            status: res.status,
            duration,
            source: data?.data?.source || 'unknown',
            data
        };
    } catch (err) {
        return { success: false, error: err.message, duration: Date.now() - start };
    }
}

// Cenário 1: V2 Totals (com snapshot)
console.log('\n📊 Cenário 1: GET /v2/totals (com snapshot)');
const r1 = await test(`/v2/totals?date=${TEST_DATE}&period=month`, 'V2 Totals');
console.log(`   Status: ${r1.status}`);
console.log(`   Duração: ${r1.duration}ms`);
console.log(`   Source: ${r1.source}`);
console.log(`   ${r1.source === 'snapshot' ? '✅ Snapshot funcionando!' : '⚠️ Usando fallback'}`);

// Cenário 2: V2 Totals (sem snapshot - primeira vez)
console.log('\n📊 Cenário 2: GET /v2/totals (data diferente - sem snapshot)');
const r2 = await test('/v2/totals?date=2025-01-01&period=month', 'V2 Totals (sem snapshot)');
console.log(`   Status: ${r2.status}`);
console.log(`   Duração: ${r2.duration}ms`);
console.log(`   Source: ${r2.source}`);
console.log(`   ${r2.source === 'sync_fallback' ? '✅ Fallback funcionando!' : '⚠️ Unexpected source'}`);

// Cenário 3: Comparar com legado
console.log('\n📊 Cenário 3: Comparativo de performance');
const r3 = await test('/payments/totals?period=month', 'Legado Totals');
console.log(`   Legado: ${r3.duration}ms`);
console.log(`   V2 (com snapshot): ${r1.duration}ms`);
const diff = r3.duration - r1.duration;
console.log(`   Diferença: ${diff > 0 ? '+' : ''}${diff}ms`);
console.log(`   ${r1.duration < r3.duration ? '✅ V2 mais rápido!' : '⚠️ Legado mais rápido'}`);

console.log('\n' + '=' .repeat(60));
console.log('\n🎯 RESUMO:');
console.log(`   Snapshot: ${r1.source === 'snapshot' ? '✅' : '❌'}`);
console.log(`   Fallback: ${r2.source === 'sync_fallback' ? '✅' : '❌'}`);
console.log(`   Performance: ${r1.duration < 500 ? '✅' : '⚠️'} (${r1.duration}ms vs ${r3.duration}ms legado)`);

const allGood = r1.source === 'snapshot' && r2.source === 'sync_fallback';
console.log(`\n${allGood ? '🎉 MIGRAÇÃO VALIDADA COM SUCESSO!' : '⚠️ REVISAR ANTES DE PRODUÇÃO'}`);
