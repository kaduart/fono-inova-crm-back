/**
 * 🧪 TESTE RÁPIDO - Amanda Orchestrator
 * 
 * Chama o orchestrator com cenários reais e mostra resultados.
 * 
 * USO:
 *   node testOrchestrator.js
 * 
 * REQUISITOS:
 *   - Estar na pasta raiz do projeto (onde tem package.json)
 *   - .env configurado com ANTHROPIC_API_KEY
 *   - MongoDB rodando (ou mockar)
 */

import "dotenv/config";

// ============================================================================
// CONFIGURAÇÃO
// ============================================================================

const ORCHESTRATOR_PATH = "../utils/amandaOrchestrator.js";
const RUN_AI_TESTS = process.env.ANTHROPIC_API_KEY ? true : false;

console.log("╔══════════════════════════════════════════════════════════════════╗");
console.log("║            🧪 TESTE RÁPIDO - Amanda Orchestrator                 ║");
console.log("╚══════════════════════════════════════════════════════════════════╝");
console.log(`\n📅 ${new Date().toLocaleString("pt-BR")}`);
console.log(`🔑 API Key: ${RUN_AI_TESTS ? "✅ Configurada" : "❌ Não configurada"}`);

// ============================================================================
// MOCK DO LEAD
// ============================================================================

const createMockLead = (overrides = {}) => ({
    _id: "mock_lead_" + Date.now(),
    name: "Teste",
    contact: { phone: "62999999999" },
    stage: "novo",
    status: "ativo",
    patientInfo: {},
    autoBookingContext: {},
    qualificationData: {},
    ...overrides,
});

// ============================================================================
// CENÁRIOS DE TESTE
// ============================================================================

const scenarios = [
    {
        name: "Saudação simples",
        input: "Oi, boa tarde",
        lead: createMockLead(),
        check: (r) => r && r.includes("💚") && !r.includes("undefined"),
    },
    {
        name: "Pergunta preço genérico",
        input: "Qual o valor da consulta?",
        lead: createMockLead(),
        check: (r) => r && r.includes("💚"),
    },
    {
        name: "Pergunta localização",
        input: "Onde fica a clínica?",
        lead: createMockLead(),
        check: (r) => r && (r.includes("endereço") || r.includes("Rua") || r.includes("💚")),
    },
    {
        name: "Pergunta plano de saúde",
        input: "Atendem Unimed?",
        lead: createMockLead(),
        check: (r) => r && (r.includes("particular") || r.includes("plano") || r.includes("💚")),
    },
    {
        name: "Queixa com idade",
        input: "Meu filho de 4 anos não fala direito",
        lead: createMockLead(),
        check: (r) => r && r.includes("💚") && !r.includes("undefined"),
    },
    {
        name: "Quer agendar (lead novo)",
        input: "Quero agendar uma avaliação",
        lead: createMockLead(),
        check: (r) => r && r.includes("💚"),
    },
    {
        name: "Lead coletando nome",
        input: "João Pedro Silva Santos",
        lead: createMockLead({
            stage: "interessado_agendamento",
            pendingPatientInfoForScheduling: true,
            pendingPatientInfoStep: "name",
            pendingChosenSlot: { date: "2025-01-06", time: "14:00", doctorName: "Dra. Ana" },
        }),
        check: (r) => r && (r.includes("nascimento") || r.includes("data")) && r.includes("💚"),
    },
    {
        name: "Lead escolhendo slot A",
        input: "A",
        lead: createMockLead({
            stage: "interessado_agendamento",
            therapyArea: "fonoaudiologia",
            pendingSchedulingSlots: {
                primary: { date: "2025-01-06", time: "14:00", doctorName: "Dra. Ana", doctorId: "1" },
                alternativesSamePeriod: [],
                alternativesOtherPeriod: [],
            },
        }),
        check: (r) => r && r.includes("💚"),
    },
];

// ============================================================================
// EXECUTOR DE TESTES
// ============================================================================

async function runTests() {
    let orchestrator;

    // Tenta importar o orchestrator
    console.log("\n📦 Importando orchestrator...");
    try {
        orchestrator = await import(ORCHESTRATOR_PATH);
        console.log("✅ Import OK\n");
    } catch (err) {
        console.log(`❌ Erro no import: ${err.message}`);
        console.log(`\n💡 Certifique-se de estar na pasta raiz do projeto`);
        console.log(`   e que o arquivo ${ORCHESTRATOR_PATH} existe.\n`);
        process.exit(1);
    }

    const fn = orchestrator.getOptimizedAmandaResponse || orchestrator.default;

    if (!fn) {
        console.log("❌ Função getOptimizedAmandaResponse não encontrada");
        process.exit(1);
    }

    console.log("═".repeat(60));
    console.log("🎭 EXECUTANDO CENÁRIOS");
    console.log("═".repeat(60));

    const results = [];

    for (const scenario of scenarios) {
        console.log(`\n🧪 ${scenario.name}`);
        console.log(`   📥 Input: "${scenario.input}"`);

        try {
            const startTime = Date.now();

            const response = await fn({
                content: scenario.input,
                userText: scenario.input,
                lead: scenario.lead,
                context: {},
                messageId: `test_${Date.now()}`,
            });

            const duration = Date.now() - startTime;
            const passed = scenario.check(response);

            // Trunca resposta pra exibição
            const displayResponse = response
                ? (response.length > 100 ? response.substring(0, 100) + "..." : response)
                : "(null)";

            console.log(`   📤 Output: "${displayResponse}"`);
            console.log(`   ⏱️  ${duration}ms`);
            console.log(`   ${passed ? "✅ PASSOU" : "❌ FALHOU"}`);

            results.push({ name: scenario.name, passed, duration, response });

        } catch (err) {
            console.log(`   💥 ERRO: ${err.message}`);
            results.push({ name: scenario.name, passed: false, error: err.message });
        }
    }

    // Resumo
    console.log("\n" + "═".repeat(60));
    console.log("📊 RESUMO");
    console.log("═".repeat(60));

    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;

    console.log(`\n✅ Passou: ${passed}/${results.length}`);
    console.log(`❌ Falhou: ${failed}/${results.length}`);

    if (failed > 0) {
        console.log("\n❌ Falhas:");
        results.filter(r => !r.passed).forEach(r => {
            console.log(`   - ${r.name}: ${r.error || "resposta inválida"}`);
        });
    }

    // Tempo médio
    const avgTime = results
        .filter(r => r.duration)
        .reduce((sum, r) => sum + r.duration, 0) / results.length;
    console.log(`\n⏱️  Tempo médio: ${Math.round(avgTime)}ms`);

    console.log("\n" + "═".repeat(60));
    if (failed === 0) {
        console.log("🎉 TODOS OS TESTES PASSARAM!");
    } else if (failed <= 2) {
        console.log("⚠️ MAIORIA DOS TESTES PASSOU - VERIFICAR FALHAS");
    } else {
        console.log("❌ MUITAS FALHAS - NÃO FAZER DEPLOY");
    }
    console.log("═".repeat(60) + "\n");

    return failed === 0;
}

// ============================================================================
// MAIN
// ============================================================================

runTests()
    .then(success => process.exit(success ? 0 : 1))
    .catch(err => {
        console.error("💥 Erro fatal:", err);
        process.exit(1);
    });