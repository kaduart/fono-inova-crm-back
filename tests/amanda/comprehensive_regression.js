
import mongoose from 'mongoose';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getOptimizedAmandaResponse } from '../../orchestrators/AmandaOrchestrator.js';
import LearningInsight from '../../models/LearningInsight.js';
import dotenv from 'dotenv';
dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, '..', '..', '..', 'tests', 'fixtures', 'conversasReaisExtraidas.json');

// Mock para leads frescos
async function makeFreshLead() {
    return {
        _id: new mongoose.Types.ObjectId(),
        stage: 'novo',
        messageCount: 0,
        contact: {
            _id: new mongoose.Types.ObjectId(),
            phone: '5562999990000',
            name: 'Teste Regressivo',
        },
        tags: [],
        autoBookingContext: {}
    };
}

// Helper de validação simples
function validateResponse(response, checks) {
    const text = (response || '').toLowerCase();
    const failures = [];

    for (const check of checks) {
        if (check.type === 'notContains') {
            for (const pattern of check.patterns) {
                if (text.includes(pattern.toLowerCase())) {
                    failures.push(`Contém termo proibido: "${pattern}"`);
                }
            }
        }
        if (check.type === 'contains') {
            // Se oneOf for true, basta um bater
            const found = check.patterns.some(p => text.includes(p.toLowerCase()));
            if (!found) {
                failures.push(`Não contém termos obrigatórios: ${check.patterns.join(', ')}`);
            }
        }
    }
    return failures;
}

async function runRegression() {
    console.log("🚀 INICIANDO REGRESSÃO ABRANGENTE (DATABASE + CRON)");

    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log("✅ DB Conectado");

        const allTests = [];

        // 1. CARREGA CENÁRIOS ESTÁTICOS (Fixtures)
        try {
            const raw = readFileSync(FIXTURE_PATH, 'utf-8');
            const data = JSON.parse(raw);
            if (data.scenarios) {
                console.log(`📂 Carregados ${data.scenarios.length} cenários estáticos do arquivo JSON.`);
                allTests.push(...data.scenarios.map(s => ({
                    source: 'static_fixture',
                    id: s.id,
                    input: s.leadMessage,
                    checks: s.checks
                })));
            }
        } catch (e) {
            console.warn("⚠️ Fixture estática não encontrada ou inválida. Pulando.");
        }

        // 2. CARREGA CENÁRIOS DINÂMICOS DO BANCO (LearningInsight)
        // Busca insights do tipo 'problem' que viraram test cases
        const insights = await LearningInsight.find({
            type: 'continuous_learning_cycle'
        }).sort({ generatedAt: -1 }).limit(5);

        let dynamicCount = 0;
        for (const insight of insights) {
            // Estrutura esperada: data.testCasesGenerated (array) ou data.patterns.problems
            const problems = insight.data?.patterns?.problems || [];

            for (const prob of problems) {
                // Converte problema em teste
                if (prob.recommendation && prob.key) {
                    // Exemplo: se o problema é "fala muito", o teste é garantir que fala pouco. 
                    // Como é genérico, vamos focar em Casos de Teste Gerados se existirem
                }
            }

            // Se houver testCases salvos diretamente no insight (nova feature)
            if (insight.data?.testCases) {
                allTests.push(...insight.data.testCases.map(tc => ({
                    source: 'dynamic_db',
                    id: `dyn_${tc.pattern}_${Date.now()}`,
                    input: tc.input.message,
                    checks: [{ type: 'contains', patterns: [tc.expectedBehavior], explanation: "Behavior match" }]
                })));
                dynamicCount += insight.data.testCases.length;
            }
        }
        console.log(`🧠 Carregados ${dynamicCount} cenários dinâmicos do MongoDB.`);

        // 3. ADICIONA CASOS CRÍTICOS MANUALMENTE (Hardcoded Safety Net)
        allTests.push({
            source: 'critical_safety',
            id: 'safety_linguinha',
            input: 'voces fazem cirurgia da linguinha?',
            checks: [
                { type: 'contains', patterns: ['não realizamos', 'apenas o teste'], matchAny: true },
                { type: 'notContains', patterns: ['posso agendar a cirurgia', 'claro', 'fazemos sim'] }
            ]
        });

        console.log(`\n📋 TOTAL DE CENÁRIOS PARA EXECUÇÃO: ${allTests.length}`);

        // 4. EXECUÇÃO
        let passed = 0;
        let failed = 0;

        for (const test of allTests) {
            // console.log(`\n🔹 Testando: [${test.source}] ${test.input.substring(0, 50)}...`);

            try {
                const lead = await makeFreshLead();
                const response = await getOptimizedAmandaResponse({
                    content: test.input,
                    userText: test.input,
                    lead,
                    context: { source: 'regression_test' }
                });

                const failures = validateResponse(response, test.checks);

                if (failures.length === 0) {
                    passed++;
                    // process.stdout.write('.');
                } else {
                    failed++;
                    console.error(`\n❌ FALHA [${test.id}]:`);
                    console.error(`   Input: "${test.input}"`);
                    console.error(`   Output: "${response?.substring(0, 100)}..."`);
                    console.error(`   Erros: ${failures.join(', ')}`);
                }
            } catch (err) {
                failed++;
                console.error(`\n💥 ERRO DE EXECUÇÃO [${test.id}]: ${err.message}`);
            }
        }

        console.log(`\n\n══════════════════════════════════`);
        console.log(`🏁 RESULTADO DA REGRESSÃO`);
        console.log(`✅ APROVADOS: ${passed}`);
        console.log(`❌ FALHADOS:  ${failed}`);
        console.log(`══════════════════════════════════`);

        if (failed > 0) process.exit(1);

    } catch (err) {
        console.error("Fatal:", err);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
    }
}

runRegression();
