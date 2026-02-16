#!/usr/bin/env node
/**
 * 🧪 RUNNER DOS 94 CENÁRIOS REAIS - via AmandaOrchestrator
 * =========================================================
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import { getOptimizedAmandaResponse } from '../../orchestrators/AmandaOrchestrator.js';
import { AmandaMetrics } from '../../utils/orchestrator/AmandaMetrics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, '..', '..', '..', 'tests', 'fixtures', 'conversasReaisExtraidas.json');

const CONCURRENCY = 1;
const TIMEOUT_PER_SCENARIO = 30_000;
const FILTER_CATEGORY = process.env.FILTER_CAT || null;
const FILTER_ID = process.env.FILTER_ID ? Number(process.env.FILTER_ID) : null;

console.log(`
╔════════════════════════════════════════════════════════════════╗
║  🧪 94 CENÁRIOS REAIS + 📊 METRICS                            ║
╚════════════════════════════════════════════════════════════════╝
`);

const metrics = new AmandaMetrics();

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

async function main() {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ MongoDB conectado\n');

    const raw = readFileSync(FIXTURE_PATH, 'utf-8');
    const data = JSON.parse(raw);
    let scenarios = data.scenarios;

    console.log(`📊 Total: ${scenarios.length} cenários`);
    console.log(`📂 Categorias: ${Object.entries(data.categories).map(([k, v]) => `${k}(${v})`).join(', ')}\n`);

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
        process.stdout.write(`${label}: "${scenario.leadMessage.substring(0, 50)}..." → `);

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
            if (resp === null) {
                responseText = '[NULL - location/action sent]';
            }

            // Métricas
            const { grade } = metrics.analyze({
                scenario,
                output: responseText
            });
            process.stdout.write(`[${grade}] `);


        } catch (err) {
            process.stdout.write(`💥 ERRO: ${err.message}\n`);
            results.errors++;
            failures.push({ id: scenario.id, category: scenario.category, error: err.message });
            continue;
        }

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
            process.stdout.write(`❌ ${failedChecks.map(f => `[${f.name}]`).join(' ')}\n`);
            process.stdout.write(`   Resp: "${responseText.substring(0, 100)}..."\n`);
            failures.push({
                id: scenario.id,
                category: scenario.category,
                message: scenario.leadMessage.substring(0, 80),
                response: responseText.substring(0, 150),
                failedChecks: failedChecks.map(f => `${f.name}: ${f.detail}`),
            });
        }
    }

    // RELATÓRIO ORIGINAL
    console.log(`\n${'═'.repeat(64)}`);
    console.log(`📊 RELATÓRIO DE TESTES`);
    console.log(`${'═'.repeat(64)}`);
    console.log(`✅ Passaram:  ${results.passed}`);
    console.log(`❌ Falharam:  ${results.failed}`);
    console.log(`💥 Erros:     ${results.errors}`);
    console.log(`📊 Total:     ${scenarios.length}`);
    console.log(`📈 Taxa:      ${((results.passed / scenarios.length) * 100).toFixed(1)}%`);

    // 🆕 RELATÓRIO DE MÉTRICAS
    console.log(`\n${'═'.repeat(64)}`);
    console.log(`📊 AMANDA METRICS`);
    console.log(`${'═'.repeat(64)}`);

    const r = metrics.getReport();
    console.log(`Total: ${r.total} | Notas: ${JSON.stringify(r.byGrade)}`);

    if (r.low && r.low.length > 0) {
        console.log(`\n⚠️  Problemas:`);
        r.low.forEach(i => console.log(`  [${i.id}] ${i.grade}`));
    }

    writeFileSync('amanda-metrics.csv', metrics.exportToCSV());
    console.log(`\n💾 CSV: amanda-metrics.csv`);

    if (failures.length > 0) {
        console.log(`\n${'─'.repeat(64)}`);
        console.log(`❌ FALHAS (${failures.length}):`);
        for (const f of failures) {
            console.log(`  [${f.id}] ${f.category}`);
            if (f.failedChecks) f.failedChecks.forEach(c => console.log(`     ❌ ${c}`));
        }
    }

    await mongoose.disconnect();

    process.exit(results.failed + results.errors > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('💥 Erro fatal:', err);
    process.exit(1);
});