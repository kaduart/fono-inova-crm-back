#!/usr/bin/env node
/**
 * 🧪 RUNNER DOS 94 CENÁRIOS REAIS - via AmandaOrchestrator
 * =========================================================
 * Executa todos os cenários de conversasReaisExtraidas.json
 * usando getOptimizedAmandaResponse() (caminho de produção).
 *
 * Uso: node -r dotenv/config tests/amanda/run-94-scenarios.js
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import { getOptimizedAmandaResponse } from '../../orchestrators/AmandaOrchestrator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, '..', '..', '..', 'tests', 'fixtures', 'conversasReaisExtraidas.json');

// ── CONFIG ──
const CONCURRENCY = 1; // sequencial pra não sobrecarregar Claude
const TIMEOUT_PER_SCENARIO = 30_000; // 30s
const FILTER_CATEGORY = process.env.FILTER_CAT || null; // ex: FILTER_CAT=PRECO
const FILTER_ID = process.env.FILTER_ID ? Number(process.env.FILTER_ID) : null;

console.log(`
╔════════════════════════════════════════════════════════════════╗
║  🧪 94 CENÁRIOS REAIS - AmandaOrchestrator                    ║
╚════════════════════════════════════════════════════════════════╝
`);

// ── FAKE LEAD BASE ──
function makeFreshLead() {
    return {
        _id: new mongoose.Types.ObjectId(),
        stage: 'novo',
        messageCount: 0,
        contact: {
            _id: new mongoose.Types.ObjectId(),
            phone: '5562999990000',
            name: 'Lead Teste',
        },
        tags: [],
    };
}

// ── CHECK VALIDATORS ──
function runCheck(check, responseText) {
    const lower = (responseText || '').toLowerCase();

    switch (check.type) {
        case 'notEmpty':
            return {
                passed: !!responseText && responseText.trim().length > 0,
                detail: responseText ? `${responseText.length} chars` : 'VAZIA',
            };

        case 'contains': {
            const patterns = check.patterns || [];
            const matches = patterns.filter(p => lower.includes(p.toLowerCase()));
            const passed = check.matchAny
                ? matches.length > 0
                : matches.length === patterns.length;
            return {
                passed,
                detail: passed
                    ? `Contém: ${matches.join(', ')}`
                    : `Faltam: ${patterns.filter(p => !lower.includes(p.toLowerCase())).join(', ')}`,
            };
        }

        case 'notContains': {
            const patterns = check.patterns || [];
            const found = patterns.filter(p => lower.includes(p.toLowerCase()));
            return {
                passed: found.length === 0,
                detail: found.length === 0
                    ? 'OK, nenhuma proibida'
                    : `Contém proibida: ${found.join(', ')}`,
            };
        }

        case 'regex': {
            const rx = new RegExp(check.pattern, check.flags || '');
            const passed = rx.test(responseText);
            return {
                passed,
                detail: passed ? `Match: /${check.pattern}/` : `Sem match: /${check.pattern}/`,
            };
        }

        default:
            return { passed: true, detail: `Tipo desconhecido: ${check.type}` };
    }
}

// ── MAIN ──
async function main() {
    // Conectar ao MongoDB
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ MongoDB conectado\n');

    // Carregar cenários
    const raw = readFileSync(FIXTURE_PATH, 'utf-8');
    const data = JSON.parse(raw);
    let scenarios = data.scenarios;

    console.log(`📊 Total: ${scenarios.length} cenários (de ${data.totalPairsExtracted} pares)`);
    console.log(`📂 Categorias: ${Object.entries(data.categories).map(([k, v]) => `${k}(${v})`).join(', ')}\n`);

    // Filtrar se necessário
    if (FILTER_CATEGORY) {
        scenarios = scenarios.filter(s => s.category === FILTER_CATEGORY);
        console.log(`🔍 Filtro: ${FILTER_CATEGORY} → ${scenarios.length} cenários\n`);
    }
    if (FILTER_ID) {
        scenarios = scenarios.filter(s => s.id === FILTER_ID);
        console.log(`🔍 Filtro ID: ${FILTER_ID} → ${scenarios.length} cenários\n`);
    }

    const results = { passed: 0, failed: 0, errors: 0, skipped: 0 };
    const failures = [];

    for (const scenario of scenarios) {
        const label = `[${scenario.id}] ${scenario.category}`;
        process.stdout.write(`${label}: "${scenario.leadMessage.substring(0, 60)}${scenario.leadMessage.length > 60 ? '...' : ''}" → `);

        let responseText;
        try {
            const resp = await Promise.race([
                getOptimizedAmandaResponse({
                    content: scenario.leadMessage,
                    userText: scenario.leadMessage,
                    lead: makeFreshLead(),
                    context: { source: 'whatsapp-inbound' },
                    messageId: `test-94-${scenario.id}-${Date.now()}`,
                }),
                new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), TIMEOUT_PER_SCENARIO)),
            ]);

            responseText = resp || '';
            // Pode retornar null (ex: cenário de localização que envia location)
            if (resp === null) {
                responseText = '[NULL - location/action sent]';
            }
        } catch (err) {
            process.stdout.write(`💥 ERRO: ${err.message}\n`);
            results.errors++;
            failures.push({ id: scenario.id, category: scenario.category, error: err.message });
            continue;
        }

        // Rodar checks
        const checkResults = scenario.checks.map(c => ({
            name: c.name,
            ...runCheck(c, responseText),
        }));

        const allPassed = checkResults.every(r => r.passed);
        if (allPassed) {
            results.passed++;
            process.stdout.write(`✅\n`);
        } else {
            results.failed++;
            const failedChecks = checkResults.filter(r => !r.passed);
            process.stdout.write(`❌ ${failedChecks.map(f => `[${f.name}: ${f.detail}]`).join(' ')}\n`);
            process.stdout.write(`   Resp: "${responseText.substring(0, 120)}${responseText.length > 120 ? '...' : ''}"\n`);
            failures.push({
                id: scenario.id,
                category: scenario.category,
                message: scenario.leadMessage.substring(0, 80),
                response: responseText.substring(0, 150),
                failedChecks: failedChecks.map(f => `${f.name}: ${f.detail}`),
            });
        }
    }

    // ── RELATÓRIO ──
    console.log(`\n${'═'.repeat(64)}`);
    console.log(`📊 RELATÓRIO FINAL`);
    console.log(`${'═'.repeat(64)}\n`);
    console.log(`✅ Passaram:  ${results.passed}`);
    console.log(`❌ Falharam:  ${results.failed}`);
    console.log(`💥 Erros:     ${results.errors}`);
    console.log(`📊 Total:     ${scenarios.length}`);
    console.log(`📈 Taxa:      ${((results.passed / scenarios.length) * 100).toFixed(1)}%\n`);

    if (failures.length > 0) {
        console.log(`\n${'─'.repeat(64)}`);
        console.log(`❌ DETALHES DAS FALHAS (${failures.length}):`);
        console.log(`${'─'.repeat(64)}\n`);
        for (const f of failures) {
            console.log(`  [${f.id}] ${f.category}: ${f.error || ''}`);
            if (f.message) console.log(`     MSG: "${f.message}"`);
            if (f.response) console.log(`     RESP: "${f.response}"`);
            if (f.failedChecks) f.failedChecks.forEach(c => console.log(`     ❌ ${c}`));
            console.log();
        }
    }

    await mongoose.disconnect();
    process.exit(results.failed + results.errors > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('💥 Erro fatal:', err);
    process.exit(1);
});
