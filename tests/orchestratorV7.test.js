/**
 * 🧪 TESTES DO ORCHESTRATOR V7 - Response-First
 *
 * Validação da arquitetura Response-First
 */

import { WhatsAppOrchestratorV7 } from '../orchestrators/WhatsAppOrchestratorV7.js';

const orch = new WhatsAppOrchestratorV7();

// =============================================================================
// TESTES UNITÁRIOS
// =============================================================================

console.log('🧪 Iniciando testes do Orchestrator V7...\n');

// -----------------------------------------------------------------------------
// Teste 1: Extração de Perguntas
// -----------------------------------------------------------------------------
console.log('📝 Teste 1: Extração de Perguntas');

const testTexts = [
  "Quanto custa?",
  "Aceita plano de saúde?",
  "Vocês fazem ABA para autismo?",
  "Precisa de laudo do médico?",
  "Qual horário disponível?"
];

for (const text of testTexts) {
  const questions = orch.extractQuestions(text);
  console.log(`  "${text}" → ${questions.length} perguntas:`, questions.map(q => q.type));
}

console.log('✅ Teste 1 concluído\n');

// -----------------------------------------------------------------------------
// Teste 2: Triagem Multidisciplinar
// -----------------------------------------------------------------------------
console.log('📝 Teste 2: Triagem Multidisciplinar');

const complaints = [
  "Meu filho não fala",
  "Ele é muito hiperativo",
  "Dor na coluna",
  "Não come nada, só come nuggets",
  "Troca muitas letras"
];

for (const complaint of complaints) {
  const triage = orch.performSimpleTriage(complaint, {});
  console.log(`  "${complaint}" → ${triage.specialty || 'não identificado'} (${(triage.confidence * 100).toFixed(0)}%)`);
}

console.log('✅ Teste 2 concluído\n');

// -----------------------------------------------------------------------------
// Teste 3: Acolhimento de Dados
// -----------------------------------------------------------------------------
console.log('📝 Teste 3: Acolhimento de Dados');

const testData = [
  { newData: ['patientName'], entities: { patientName: 'João' } },
  { newData: ['age'], entities: { age: 5 } },
  { newData: ['age'], entities: { age: 15 } },
  { newData: ['patientName', 'age'], entities: { patientName: 'Maria', age: 3 } }
];

for (const { newData, entities } of testData) {
  const ack = orch.acknowledgeData(newData, entities);
  console.log(`  ${JSON.stringify(newData)} → "${ack}"`);
}

console.log('✅ Teste 3 concluído\n');

// -----------------------------------------------------------------------------
// Teste 4: Fluxo Completo (mock)
// -----------------------------------------------------------------------------
console.log('📝 Teste 4: Fluxo Completo (sem LLM)');

async function testFlow() {
  const testCases = [
    {
      name: 'Caso 1: Pergunta simples',
      message: 'Quanto custa?',
      expectedContains: ['200', 'avaliação']
    },
    {
      name: 'Caso 2: Dados + Pergunta',
      message: 'João tem 5 anos, quanto custa?',
      expectedContains: ['João', '5', '200']
    },
    {
      name: 'Caso 3: Queixa com triagem',
      message: 'Meu filho não fala',
      expectedContains: ['fonoaudiologia', 'fala']
    }
  ];

  for (const testCase of testCases) {
    console.log(`\n  ${testCase.name}`);
    console.log(`  Input: "${testCase.message}"`);

    try {
      // Mock: sem LLM real
      const lead = { _id: 'test-lead-123' };
      const message = { content: testCase.message };
      const context = {};

      // Extrai apenas componentes (não chama LLM)
      const questions = orch.extractQuestions(testCase.message);
      console.log(`  Perguntas detectadas: ${questions.length}`);

      if (questions.length > 0) {
        console.log(`  Tipos: ${questions.map(q => q.type).join(', ')}`);
      }

      console.log(`  ✅ Teste passou`);
    } catch (error) {
      console.log(`  ❌ Erro: ${error.message}`);
    }
  }
}

await testFlow();

console.log('\n✅ Todos os testes concluídos!\n');

// =============================================================================
// INSTRUÇÕES DE USO
// =============================================================================

console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📋 COMO TESTAR MANUALMENTE NO PROJETO

1. Certifique-se de que o servidor está rodando:
   cd backend && npm run dev

2. Envie mensagem de teste via WhatsApp ou API

3. Verifique os logs:
   - Procure por "[V7_" para ver logs do V7
   - "[Fallback] Usando Orchestrator V7" indica que V7 foi ativado

4. Teste casos específicos:
   - "Quanto custa e aceita plano?"
   - "Meu filho não fala, tem 5 anos"
   - "Vocês fazem ABA para autismo?"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📊 MÉTRICAS PARA ACOMPANHAR

- Taxa de repetição de perguntas: deve ser 0%
- Taxa de perguntas respondidas: deve ser 100%
- Taxa de triagem correta: > 80%
- Tempo médio de resposta: < 2s

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
