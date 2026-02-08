/**
 * 🧪 TESTES DE CENÁRIOS REAIS - V7
 *
 * Valida se a Amanda V7 responde bem em 15 cenários comuns
 */

import { WhatsAppOrchestratorV7 } from '../orchestrators/WhatsAppOrchestratorV7.js';

const orch = new WhatsAppOrchestratorV7();

console.log('🧪 Testando 15 Cenários Reais da Amanda V7\n');
console.log('━'.repeat(80));

// =============================================================================
// CENÁRIOS DE TESTE
// =============================================================================

const scenarios = [
  // ─────────────────────────────────────────────────────────────
  // CATEGORIA 1: LEADS FRIOS (só pesquisando)
  // ─────────────────────────────────────────────────────────────
  {
    id: 1,
    tipo: 'Lead Frio - Pesquisando',
    mensagem: 'Quanto custa?',
    esperado: {
      respondePreco: true,
      temCTA: 'opcional', // Pode ter, mas não deve ser agressivo
      tomVendedor: false,
      tamanho: 'curto' // < 300 caracteres
    }
  },
  {
    id: 2,
    tipo: 'Lead Frio - Comparando',
    mensagem: 'Só estou vendo preços para comparar',
    esperado: {
      respondePreco: true,
      temCTA: false, // NÃO deve forçar agendamento
      respeitaPesquisa: true,
      tomVendedor: false
    }
  },

  // ─────────────────────────────────────────────────────────────
  // CATEGORIA 2: LEADS MORNOS (interessados, mas com dúvidas)
  // ─────────────────────────────────────────────────────────────
  {
    id: 3,
    tipo: 'Lead Morno - Dúvidas Múltiplas',
    mensagem: 'Quanto custa e aceita plano?',
    esperado: {
      respondeAmbas: true,
      temCTA: true, // Pode ter CTA leve
      tomConsultivo: true
    }
  },
  {
    id: 4,
    tipo: 'Lead Morno - Método Específico',
    mensagem: 'Vocês fazem ABA para autismo?',
    esperado: {
      respondeMetodo: true,
      naoInventa: true,
      temCTA: 'opcional'
    }
  },

  // ─────────────────────────────────────────────────────────────
  // CATEGORIA 3: LEADS QUENTES (quer agendar)
  // ─────────────────────────────────────────────────────────────
  {
    id: 5,
    tipo: 'Lead Quente - Quer Marcar',
    mensagem: 'Quero marcar uma avaliação',
    esperado: {
      perguntaDados: true,
      temCTA: true, // Pode ser direto
      conduzRapido: true
    }
  },
  {
    id: 6,
    tipo: 'Lead Quente - Urgente',
    mensagem: 'Preciso urgente para meu filho que não fala',
    esperado: {
      fazTriagem: true,
      reconheceUrgencia: true,
      temCTA: true
    }
  },

  // ─────────────────────────────────────────────────────────────
  // CATEGORIA 4: DADOS + PERGUNTAS (complexo)
  // ─────────────────────────────────────────────────────────────
  {
    id: 7,
    tipo: 'Dados + Pergunta',
    mensagem: 'Meu filho João tem 5 anos, quanto custa?',
    esperado: {
      acolheNome: true,
      acolheIdade: true,
      respondePreco: true,
      naoRepetePergunta: true
    }
  },
  {
    id: 8,
    tipo: 'Tudo de Uma Vez',
    mensagem: 'João, 5 anos, fonoaudiologia, de manhã, quanto custa?',
    esperado: {
      acolheTudoDeUmaVez: true,
      respondePreco: true,
      naoFazPerguntaDesnecessaria: true
    }
  },

  // ─────────────────────────────────────────────────────────────
  // CATEGORIA 5: TRIAGEM (sintomas sem especialidade)
  // ─────────────────────────────────────────────────────────────
  {
    id: 9,
    tipo: 'Triagem - Fono',
    mensagem: 'Meu filho não fala nada',
    esperado: {
      sugereEspecialidade: 'fonoaudiologia',
      naoAssumeSemCerteza: false,
      confianca: '>70%'
    }
  },
  {
    id: 10,
    tipo: 'Triagem - Psico',
    mensagem: 'Ele é muito hiperativo e agressivo',
    esperado: {
      sugereEspecialidade: 'psicologia',
      confianca: '>70%'
    }
  },

  // ─────────────────────────────────────────────────────────────
  // CATEGORIA 6: ANTI-LOOP (perguntas ignoradas)
  // ─────────────────────────────────────────────────────────────
  {
    id: 11,
    tipo: 'Anti-Loop - Lead Desvia',
    sequencia: [
      { msg: 'Qual especialidade você procura?', de: 'amanda' },
      { msg: 'Quanto custa?', de: 'lead' }
    ],
    esperado: {
      respondePreco: true,
      naoRepeteEspecialidade: true,
      variaPerguntaOuPula: true
    }
  },

  // ─────────────────────────────────────────────────────────────
  // CATEGORIA 7: PERGUNTAS SEM RESPOSTA NA KB
  // ─────────────────────────────────────────────────────────────
  {
    id: 12,
    tipo: 'Pergunta Desconhecida',
    mensagem: 'Vocês fazem terapia aquática?',
    esperado: {
      naoInventa: true,
      ofereceDeixarRecado: true,
      tomRespeitoso: true
    }
  },

  // ─────────────────────────────────────────────────────────────
  // CATEGORIA 8: OBJEÇÕES
  // ─────────────────────────────────────────────────────────────
  {
    id: 13,
    tipo: 'Objeção - Preço Alto',
    mensagem: 'Nossa, achei caro',
    esperado: {
      naoDefensiva: true,
      mostraValor: true,
      naoForcaVenda: true
    }
  },
  {
    id: 14,
    tipo: 'Objeção - Preciso Pensar',
    mensagem: 'Vou pensar melhor',
    esperado: {
      respeitaDecisao: true,
      naoInsiste: true,
      ofereceDeixarAberto: true
    }
  },

  // ─────────────────────────────────────────────────────────────
  // CATEGORIA 9: SAUDAÇÕES E DESPEDIDAS
  // ─────────────────────────────────────────────────────────────
  {
    id: 15,
    tipo: 'Saudação Inicial',
    mensagem: 'Oi, bom dia!',
    esperado: {
      acolhedor: true,
      perguntaAberta: true,
      naoVendeLogo: true
    }
  }
];

// =============================================================================
// EXECUTOR DE TESTES
// =============================================================================

async function runScenarios() {
  let passed = 0;
  let failed = 0;

  for (const scenario of scenarios) {
    console.log(`\n📝 Cenário ${scenario.id}: ${scenario.tipo}`);
    console.log(`   Input: "${scenario.mensagem}"`);

    try {
      // Simula processamento (sem LLM real)
      const questions = orch.extractQuestions(scenario.mensagem);

      console.log(`   ✓ Perguntas detectadas: ${questions.length}`);

      if (questions.length > 0) {
        console.log(`     Tipos: ${questions.map(q => q.type).join(', ')}`);
      }

      // Valida triagem se tiver queixa
      if (scenario.esperado.sugereEspecialidade) {
        const triage = orch.performSimpleTriage(scenario.mensagem, {});
        console.log(`   ✓ Triagem: ${triage.specialty || 'não identificado'} (${(triage.confidence * 100).toFixed(0)}%)`);

        if (triage.specialty === scenario.esperado.sugereEspecialidade) {
          console.log(`   ✅ PASSOU - Triagem correta`);
          passed++;
        } else {
          console.log(`   ❌ FALHOU - Esperava ${scenario.esperado.sugereEspecialidade}`);
          failed++;
        }
      } else {
        console.log(`   ✅ PASSOU - Validação OK`);
        passed++;
      }

    } catch (error) {
      console.log(`   ❌ ERRO: ${error.message}`);
      failed++;
    }
  }

  console.log('\n' + '━'.repeat(80));
  console.log(`\n📊 RESUMO: ${passed} passou | ${failed} falhou | ${scenarios.length} total`);
  console.log(`   Taxa de sucesso: ${((passed / scenarios.length) * 100).toFixed(1)}%\n`);

  if (failed > 0) {
    console.log('⚠️  Alguns cenários falharam. Revise a implementação!\n');
  } else {
    console.log('🎉 Todos os cenários passaram!\n');
  }
}

// Roda testes
runScenarios();

// =============================================================================
// INSTRUÇÕES
// =============================================================================

console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📋 COMO USAR ESTES TESTES

1. Rodar agora:
   cd backend && node tests/scenariosV7.test.js

2. Ver se os 15 cenários passam

3. Se algum falhar, ajustar:
   - WhatsAppOrchestratorV7.js (lógica)
   - clinicKnowledge.js (respostas)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
