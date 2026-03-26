#!/usr/bin/env node
/**
 * 🔥 QA DIRECIONADO — 6 Cenários Críticos
 * 
 * Validação obrigatória antes de qualquer deploy
 * Garante que o sistema de intenções está funcionando
 * 
 * Uso: node SCRIPT-qa-cenarios-criticos.js
 */

import mongoose from 'mongoose';
import { getOptimizedAmandaResponse } from '../../orchestrators/AmandaOrchestrator.js';
import 'dotenv/config';

const MONGO_URI = process.env.MONGO_URI;

// ═══════════════════════════════════════════════════════════
// 6 CENÁRIOS CRÍTICOS (fonte da verdade)
// ═══════════════════════════════════════════════════════════

const CENARIOS_CRITICOS = [
  {
    id: 1,
    nome: 'Saudação pura',
    entrada: 'oi',
    intencaoEsperada: 'FIRST_CONTACT',
    deveBypass: true,
    naoDeveConter: ['me conta o que você está buscando', 'direcionar para a especialidade'],
    criterio: 'Deve cair em FIRST_CONTACT e ir para IA'
  },
  {
    id: 2,
    nome: 'Intenção vaga',
    entrada: 'quero saber mais',
    intencaoEsperada: 'FIRST_CONTACT',
    deveBypass: true,
    naoDeveConter: ['me conta o que você está buscando'],
    criterio: 'Deve cair em FIRST_CONTACT e ir para IA'
  },
  {
    id: 3,
    nome: 'Sintoma direto',
    entrada: 'meu filho não fala direito',
    intencaoEsperada: 'SINTOMA',
    deveBypass: true,
    naoDeveConter: ['me conta o que você está buscando'],
    criterio: 'Deve detectar SINTOMA e não usar resposta genérica'
  },
  {
    id: 4,
    nome: 'Explicação',
    entrada: 'como funciona a avaliação',
    intencaoEsperada: 'EXPLICACAO',
    deveBypass: true,
    naoDeveConter: ['manhã ou tarde', 'me conta o que você está buscando'],
    criterio: 'Deve detectar EXPLICACAO e ir para IA'
  },
  {
    id: 5,
    nome: 'Preço',
    entrada: 'quanto custa',
    intencaoEsperada: 'PRECO',
    deveBypass: false,
    deveConter: ['r$'],
    criterio: 'Deve dar valor (R$) e conduzir'
  },
  {
    id: 6,
    nome: 'Agendamento',
    entrada: 'quero agendar',
    intencaoEsperada: 'AGENDAMENTO',
    deveBypass: false,
    naoDeveConter: ['me conta o que você está buscando'],
    criterio: 'Deve seguir fluxo estruturado (não genérico)'
  },
  // ═══════════════════════════════════════════════════════════
  // CENÁRIOS REAIS DO SITE (Log de Produção 2026-03-25)
  // ═══════════════════════════════════════════════════════════
  {
    id: 7,
    nome: 'Site - Mensagem completa com explicação',
    entrada: 'Oi! Vi no site sobre avaliação psicológica e queria entender melhor.\n\nÉ para meu filho(a). Pode me explicar como funciona?',
    intencaoEsperada: 'EXPLICACAO',
    deveBypass: true,
    naoDeveConter: ['me conta o que você está buscando', 'direcionar para a especialidade'],
    criterio: 'Mensagem real do site - deve detectar EXPLICACAO e ir para IA'
  },
  {
    id: 8,
    nome: 'Site - Queria entender (sem explicação explícita)',
    entrada: 'Oi! Vi no site sobre avaliação psicológica e queria entender melhor.',
    intencaoEsperada: 'FIRST_CONTACT',
    deveBypass: true,
    naoDeveConter: ['me conta o que você está buscando', 'direcionar para a especialidade'],
    criterio: 'Mensagem curta do site - deve ser FIRST_CONTACT com acolhimento'
  },
  {
    id: 9,
    nome: 'Site - Preciso pra mim mesmo',
    entrada: 'Preciso pra mim mesmo',
    intencaoEsperada: 'FIRST_CONTACT',
    deveBypass: true,
    naoDeveConter: ['me conta o que você está buscando'],
    criterio: 'Resposta adulto do site - deve ser FIRST_CONTACT'
  },
  {
    id: 10,
    nome: 'Site - Confirmação simples',
    entrada: 'Sim',
    intencaoEsperada: 'FIRST_CONTACT',
    deveBypass: true,
    criterio: 'Resposta curta de confirmação - contexto dependente'
  },
  // ═══════════════════════════════════════════════════════════
  // CENÁRIOS QUE ESTAVAM RETORNANDO NULL (CORREÇÃO CRÍTICA)
  // ═══════════════════════════════════════════════════════════
  {
    id: 11,
    nome: 'Site - Terapia Ocupacional',
    entrada: 'Oi! Vi no site sobre terapia ocupacional. Pode me explicar como funciona a avaliação?',
    intencaoEsperada: 'EXPLICACAO',
    deveBypass: true,
    naoDeveConter: ['null', '[SEM RESPOSTA]'],
    deveConter: ['Terapia Ocupacional', 'nome', 'idade'],
    criterio: 'NUNCA pode retornar null - fallback obrigatório'
  },
  {
    id: 12,
    nome: 'Site - Psicologia',
    entrada: 'Oi! Vi no site sobre avaliação psicológica. É para meu filho. Pode me explicar?',
    intencaoEsperada: 'EXPLICACAO',
    deveBypass: true,
    naoDeveConter: ['null', '[SEM RESPOSTA]'],
    deveConter: ['Psicologia', 'nome', 'idade'],
    criterio: 'NUNCA pode retornar null - fallback obrigatório'
  },
  {
    id: 13,
    nome: 'Site - Fonoaudiologia',
    entrada: 'Oi! Vi no site sobre fonoaudiologia. É para meu filho. Pode me explicar?',
    intencaoEsperada: 'EXPLICACAO',
    deveBypass: true,
    naoDeveConter: ['null', '[SEM RESPOSTA]'],
    deveConter: ['Fonoaudiologia', 'nome', 'idade'],
    criterio: 'NUNCA pode retornar null - fallback obrigatório'
  }
];

// ═══════════════════════════════════════════════════════════
// FUNÇÕES AUXILIARES
// ═══════════════════════════════════════════════════════════

function criarLeadBase() {
  return {
    _id: new mongoose.Types.ObjectId(),
    stage: 'novo',
    messageCount: 1,
    therapyArea: 'fonoaudiologia',
    contact: {
      _id: new mongoose.Types.ObjectId(),
      phone: '5562999990001',
      name: 'Teste QA'
    },
    tags: []
  };
}

function validarResposta(resposta, cenario) {
  const texto = (resposta?.text || resposta || '').toLowerCase();
  const erros = [];
  const acertos = [];
  
  // Verifica se deve conter
  if (cenario.deveConter) {
    for (const termo of cenario.deveConter) {
      if (texto.includes(termo.toLowerCase())) {
        acertos.push(`✅ Contém "${termo}"`);
      } else {
        erros.push(`❌ Não contém "${termo}"`);
      }
    }
  }
  
  // Verifica se NÃO deve conter
  if (cenario.naoDeveConter) {
    for (const termo of cenario.naoDeveConter) {
      if (texto.includes(termo.toLowerCase())) {
        erros.push(`❌ Contém "${termo}" (não deveria)`);
      } else {
        acertos.push(`✅ Não contém "${termo}"`);
      }
    }
  }
  
  // Critério geral
  const passou = erros.length === 0;
  
  return { passou, erros, acertos, texto };
}

// ═══════════════════════════════════════════════════════════
// EXECUÇÃO PRINCIPAL
// ═══════════════════════════════════════════════════════════

async function run() {
  console.log('\n🔥 QA DIRECIONADO — 6 Cenários Críticos\n');
  console.log('═══════════════════════════════════════════════════════════\n');
  
  await mongoose.connect(MONGO_URI);
  console.log('✅ Conectado ao MongoDB\n');
  
  const resultados = [];
  let passaram = 0;
  let falharam = 0;
  
  for (const cenario of CENARIOS_CRITICOS) {
    console.log(`\n📌 Teste #${cenario.id}: ${cenario.nome}`);
    console.log(`   Entrada: "${cenario.entrada}"`);
    console.log(`   Esperado: ${cenario.intencaoEsperada} | BYPASS: ${cenario.deveBypass ? 'SIM' : 'NÃO'}`);
    
    try {
      const lead = criarLeadBase();
      const resposta = await getOptimizedAmandaResponse({
        content: cenario.entrada,
        userText: cenario.entrada,
        lead,
        context: { source: 'whatsapp-inbound', stage: 'novo', isReplay: true },
        messageId: `qa-${Date.now()}`
      });
      
      const validacao = validarResposta(resposta, cenario);
      
      console.log(`   Resposta: ${validacao.texto.substring(0, 60)}...`);
      
      if (validacao.passou) {
        console.log('   ✅ PASSOU');
        validacao.acertos.forEach(a => console.log(`      ${a}`));
        passaram++;
      } else {
        console.log('   ❌ FALHOU');
        validacao.erros.forEach(e => console.log(`      ${e}`));
        falharam++;
      }
      
      resultados.push({
        cenario: cenario.nome,
        passou: validacao.passou,
        erros: validacao.erros
      });
      
    } catch (err) {
      console.log(`   💥 ERRO: ${err.message}`);
      falharam++;
      resultados.push({ cenario: cenario.nome, passou: false, erro: err.message });
    }
  }
  
  // Resumo
  console.log('\n\n═══════════════════════════════════════════════════════════');
  console.log('📊 RESUMO FINAL');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`\nTotal: ${CENARIOS_CRITICOS.length}`);
  console.log(`✅ Passaram: ${passaram}`);
  console.log(`❌ Falharam: ${falharam}`);
  console.log(`📈 Taxa de sucesso: ${Math.round((passaram / CENARIOS_CRITICOS.length) * 100)}%`);
  
  if (falharam === 0) {
    console.log('\n🎉 TODOS OS CENÁRIOS PASSARAM!');
    console.log('✅ Sistema pronto para deploy\n');
    process.exit(0);
  } else {
    console.log('\n⚠️  ALGUNS CENÁRIOS FALHARAM');
    console.log('❌ NÃO fazer deploy até corrigir\n');
    process.exit(1);
  }
}

run().catch(err => {
  console.error('💥 Erro fatal:', err);
  process.exit(1);
});
