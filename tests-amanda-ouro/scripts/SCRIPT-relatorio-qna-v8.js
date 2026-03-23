#!/usr/bin/env node
/**
 * 💎 RELATÓRIO Q&A — Amanda FSM V8
 * 
 * Gera um relatório completo de Perguntas e Respostas para análise humana.
 * Formato "ouro" — fácil de ler, comparar e tomar decisões.
 * 
 * Uso: node tests/relatorio-qna-amanda-v8.js
 */

import mongoose from 'mongoose';
import Leads from '../models/Leads.js';
import { getOptimizedAmandaResponse } from '../orchestrators/AmandaOrchestrator.js';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
dotenv.config();

const MONGO_URI = process.env.MONGO_URI;

// ═══════════════════════════════════════════════════════════
// CENÁRIOS DE TESTE COMPLETOS
// ═══════════════════════════════════════════════════════════

const CENARIOS = [
  {
    id: 'IN-01',
    nome: 'TEA sem diagnóstico',
    categoria: 'Intenção Emocional',
    statusEsperado: 'APROVADO',
    leadPergunta: 'meu filho de 3 anos não olha nos olhos e não responde quando chamamos',
    contexto: 'Pai preocupado com sinais de TEA. Amanda deve acolher SEM diagnosticar.',
    criterios: {
      deveFazer: ['Acolher com empatia', 'Mencionar equipe multiprofissional', 'NÃO diagnosticar', 'Convidar para continuar'],
      naoDeveFazer: ['Diagnosticar TEA', 'Confirmar autismo', 'Dar laudo', 'Falar "seu filho tem..."'],
      tomEsperado: 'Empático, acolhedor, informativo, cuidadoso'
    },
    avaliacaoHumana: {
      passou: null,
      observacoes: '',
      ajustesSugeridos: ''
    }
  },
  {
    id: 'RL-06',
    nome: 'Como funciona a TO?',
    categoria: 'Referral Educacional',
    statusEsperado: 'APROVADO',
    leadPergunta: 'Queria saber como funciona a terapia ocupacional',
    contexto: 'Lead educacional — quer entender a especialidade antes de se comprometer.',
    criterios: {
      deveFazer: ['Explicar o que é TO', 'Listar habilidades trabalhadas', 'Convidar para qualificar (abrir para contexto)'],
      naoDeveFazer: ['Ser vago', 'Não explicar', 'Mandar procurar no Google'],
      tomEsperado: 'Educativo, claro, convidativo'
    },
    avaliacaoHumana: {
      passou: null,
      observacoes: '',
      ajustesSugeridos: ''
    }
  },
  {
    id: 'RL-02',
    nome: 'Plano de saúde no início',
    categoria: 'Referral Lateral',
    statusEsperado: 'INCOMPLETO',
    problemaConhecido: 'Responde sobre plano mas NÃO qualifica depois. Secretária real precisou perguntar "Gostaria de conhecer nossos valores?"',
    leadPergunta: 'Vocês atendem plano ou só particular?',
    contexto: 'Lead começa com objeção/pergunta sobre plano. Amanda deve responder E voltar à qualificação.',
    criterios: {
      deveFazer: ['Explicar reembolso', 'Continuar qualificação', 'Perguntar especialidade OU idade OU queixa'],
      naoDeveFazer: ['Parar na resposta do plano', 'Não retomar o fluxo', 'Esperar lead perguntar'],
      tomEsperado: 'Informativo, proativo'
    },
    respostaEsperadaIdeal: 'Trabalhamos com reembolso de todos os planos! Você paga a sessão e emitimos os documentos para reembolso. 😊\n\nE me conta: qual especialidade você está procurando para a criança?',
    avaliacaoHumana: {
      passou: null,
      observacoes: '',
      ajustesSugeridos: ''
    }
  },
  {
    id: 'PL-01',
    nome: 'Plano + Unimed na primeira mensagem',
    categoria: 'Plano de Saúde Específico',
    statusEsperado: 'INCOMPLETO',
    problemaConhecido: 'Já sabe que é fonoaudiologia (lead perguntou "fonoaudiólogos") mas não aproveita contexto.',
    leadPergunta: 'quais fonoaudiólogos atendem Unimed?',
    contexto: 'Lead já deu a dica: quer fonoaudiologia. Amanda deve pegar esse gancho.',
    criterios: {
      deveFazer: ['Confirmar reembolso Unimed', 'Reconhecer fonoaudiologia', 'Perguntar idade', 'Perguntar queixa específica'],
      naoDeveFazer: ['Perguntar "qual especialidade?"', 'Ignorar que já falou fonoaudiologia'],
      tomEsperado: 'Atento, aproveitando contexto'
    },
    respostaEsperadaIdeal: 'Trabalhamos com reembolso da Unimed sim! 🎉\n\nViu que você mencionou fonoaudiologia — sua criança tem alguma dificuldade específica de fala? E qual a idade dela?',
    avaliacaoHumana: {
      passou: null,
      observacoes: '',
      ajustesSugeridos: ''
    }
  },
  {
    id: 'RL-05',
    nome: 'Linguinha fora do escopo ❌ REPROVADO',
    categoria: 'Referral Lateral',
    statusEsperado: 'REPROVADO',
    problemaConhecido: 'CONFIRMOU SERVIÇO QUE NÃO EXISTE! A clínica NÃO faz teste da linguinha. Risco de expectativa falsa.',
    leadPergunta: 'Fazem teste da linguinha?',
    contexto: 'Lead perguntando sobre serviço fora do escopo. Amanda deve ESCLARECER, não confirmar.',
    criterios: {
      deveFazer: ['ESCLARECER que não fazemos', 'Explicar quem faz (pediatra/otorrino)', 'Mencionar que fazemos reabilitação pós-cirúrgica', 'Redirecionar para queixa real'],
      naoDeveFazer: ['Dizer "sim"', 'Confirmar que fazemos', 'Oferecer agendar teste', 'Falar "realizamos a avaliação"'],
      tomEsperado: 'Claro, esclarecedor, redirecionando'
    },
    respostaEsperadaIdeal: 'Na verdade, o teste da linguinha (avaliação do freio lingual) é feito pelo pediatra ou otorrino. Aqui na clínica fazemos a reabilitação fonoaudiológica depois da cirurgia, se indicado.\n\nSua criança está com alguma dificuldade de fala ou alimentação?',
    notaCritica: '🚨 URGENTE: Correção necessária antes de produção!',
    avaliacaoHumana: {
      passou: null,
      observacoes: '',
      ajustesSugeridos: ''
    }
  },
  {
    id: 'RL-04',
    nome: 'Pacote mensal — alta intenção',
    categoria: 'Referral Lateral',
    statusEsperado: 'RUIM',
    problemaConhecido: 'Lead demonstrou alta intenção ("vou fazer o pacote") mas Amanda REGREDIU perguntando especialidade. Secretária real já foi direto para "manhã ou tarde?"',
    leadPergunta: 'Como faço pra marcar, vou fazer o pacote mensal',
    contexto: 'Lead HOT — já decidiu, quer agendar. Amanda deve ir para disponibilidade, não voltar ao início.',
    criterios: {
      deveFazer: ['Reconhecer sinal de compra', 'Ir para agendamento', 'Perguntar disponibilidade (manhã/tarde)', 'Coletar dados pendentes de forma rápida'],
      naoDeveFazer: ['Voltar perguntando especialidade do zero', 'Regredir o fluxo', 'Fazer parecer que não entendeu'],
      tomEsperado: 'Assertivo, ágil, facilitador'
    },
    respostaEsperadaIdeal: 'Que ótimo! Vou te ajudar com o pacote mensal! 😊\n\nVocê prefere atendimento de manhã ou tarde?',
    avaliacaoHumana: {
      passou: null,
      observacoes: '',
      ajustesSugeridos: ''
    }
  },
  {
    id: 'MC-01',
    nome: 'Múltiplas crianças (TEA + TDAH) ❌ CRASH',
    categoria: 'Multi-Child',
    statusEsperado: 'CRASH',
    problemaConhecido: 'ERRO TÉCNICO: Cannot read properties of null (reading \'leadData\'). Bug ao processar múltiplas crianças.',
    leadPergunta: 'Preciso de avaliação para os dois na terapia ocupacional',
    contexto: 'Mãe com dois filhos precisando do mesmo serviço. Cenário comum que está crashando.',
    criterios: {
      deveFazer: ['NÃO crashar', 'Reconhecer múltiplas crianças', 'Coletar dados de ambos', 'Organizar agendamento'],
      naoDeveFazer: ['Crashar com erro', 'Ignorar uma das crianças', 'Confundir informações'],
      tomEsperado: 'Organizado, claro, facilitador'
    },
    respostaEsperadaIdeal: 'Que bom que você quer cuidar dos dois! 🎉\n\nPara organizar as avaliações:\n\n**Primeira criança:** qual idade e queixa?\n**Segunda criança:** mesma idade? Mesma queixa?\n\nPrefere agendar no mesmo dia ou dias diferentes?',
    notaCritica: '🚨 URGENTE: Bug técnico — corrigir null pointer em leadData!',
    avaliacaoHumana: {
      passou: null,
      observacoes: '',
      ajustesSugeridos: ''
    }
  }
];

// ═══════════════════════════════════════════════════════════
// FUNÇÕES AUXILIARES
// ═══════════════════════════════════════════════════════════

async function testarCenario(cenario) {
  const phone = `55629999${cenario.id.replace(/\D/g, '').padStart(4, '0')}`;
  
  // Limpa e cria lead
  await Leads.deleteOne({ 'contact.phone': phone });
  const lead = new Leads({
    contact: { phone: phone },
    name: `Teste ${cenario.id}`,
    stage: 'novo',
    messageCount: 0
  });
  await lead.save();

  let respostaReal = null;
  let erro = null;
  let tempoResposta = 0;

  try {
    const inicio = Date.now();
    respostaReal = await getOptimizedAmandaResponse({
      content: cenario.leadPergunta,
      userText: cenario.leadPergunta,
      lead: lead,
      context: {
        stage: 'novo',
        messageCount: 1,
        conversationHistory: [],
        phone: phone
      }
    });
    tempoResposta = Date.now() - inicio;
  } catch (error) {
    erro = {
      mensagem: error.message,
      stack: error.stack
    };
  }

  await Leads.deleteOne({ 'contact.phone': phone });

  return {
    ...cenario,
    respostaReal,
    erro,
    tempoResposta,
    timestamp: new Date().toISOString()
  };
}

function gerarRelatorioMarkdown(resultados) {
  const dataHora = new Date().toLocaleString('pt-BR');
  
  let md = `# 💎 RELATÓRIO Q&A — Amanda FSM V8\n\n`;
  md += `**Gerado em:** ${dataHora}  \n`;
  md += `**Total de cenários:** ${resultados.length}  \n`;
  md += `**Status:** ${resultados.filter(r => r.erro).length > 0 ? '🔴 COM ERROS' : '🟢 OK'}\n\n`;
  
  md += `---\n\n`;
  
  // Resumo executivo
  md += `## 📊 Resumo Executivo\n\n`;
  md += `| ID | Cenário | Status Esperado | Resultado | Tempo |\n`;
  md += `|-----|---------|-----------------|-----------|-------|\n`;
  
  resultados.forEach(r => {
    const resultado = r.erro ? '💥 CRASH' : (r.respostaReal ? '✅ Respondido' : '❌ Vazio');
    const tempo = r.tempoResposta ? `${r.tempoResposta}ms` : '-';
    md += `| ${r.id} | ${r.nome} | ${r.statusEsperado} | ${resultado} | ${tempo} |\n`;
  });
  
  md += `\n---\n\n`;
  
  // Detalhamento de cada cenário
  resultados.forEach((r, index) => {
    md += `## ${index + 1}. ${r.id} — ${r.nome}\n\n`;
    
    // Metadados
    md += `**Categoria:** ${r.categoria}  \n`;
    md += `**Status Esperado:** ${r.statusEsperado}  \n`;
    md += `**Tempo de Resposta:** ${r.tempoResposta}ms  \n\n`;
    
    // Problema conhecido
    if (r.problemaConhecido) {
      md += `> ⚠️ **Problema Conhecido:** ${r.problemaConhecido}\n\n`;
    }
    if (r.notaCritica) {
      md += `> ${r.notaCritica}\n\n`;
    }
    
    // PERGUNTA
    md += `### 👤 PERGUNTA DO LEAD\n\n`;
    md += `> **"${r.leadPergunta}"**\n\n`;
    md += `**Contexto:** ${r.contexto}\n\n`;
    
    // RESPOSTA
    md += `### 🤖 RESPOSTA DA AMANDA\n\n`;
    if (r.erro) {
      md += `\`\`\`\n💥 ERRO: ${r.erro.mensagem}\n\`\`\`\n\n`;
      md += `<details>\n<summary>Stack Trace</summary>\n\n\`\`\`\n${r.erro.stack}\n\`\`\`\n</details>\n\n`;
    } else if (r.respostaReal) {
      md += `\`\`\`\n${r.respostaReal}\n\`\`\`\n\n`;
    } else {
      md += `*(Sem resposta)*\n\n`;
    }
    
    // ANÁLISE ESPERADA
    md += `### 📋 ANÁLISE ESPERADA\n\n`;
    md += `**Critérios:**\n\n`;
    
    if (r.criterios.deveFazer) {
      md += `✅ **Deve fazer:**\n`;
      r.criterios.deveFazer.forEach(item => md += `- ${item}\n`);
      md += `\n`;
    }
    
    if (r.criterios.naoDeveFazer) {
      md += `❌ **NÃO deve fazer:**\n`;
      r.criterios.naoDeveFazer.forEach(item => md += `- ${item}\n`);
      md += `\n`;
    }
    
    md += `**Tom esperado:** ${r.criterios.tomEsperado}\n\n`;
    
    if (r.respostaEsperadaIdeal) {
      md += `### ✨ RESPOSTA IDEAL (Sugestão)\n\n`;
      md += `> ${r.respostaEsperadaIdeal.split('\n').join('\n> ')}\n\n`;
    }
    
    // AVALIAÇÃO HUMANA (para preencher)
    md += `### 📝 AVALIAÇÃO HUMANA\n\n`;
    md += `- [ ] **Passou no teste**\n`;
    md += `- [ ] **Precisa de ajustes**\n`;
    md += `- [ ] **Reprovado**\n\n`;
    md += `**Observações:**\n\n`;
    md += `\`\`\`\n[Anotar observações aqui...]\n\`\`\`\n\n`;
    md += `**Ajustes sugeridos:**\n\n`;
    md += `\`\`\`\n[Descrever ajustes necessários...]\n\`\`\`\n\n`;
    
    md += `---\n\n`;
  });
  
  // Seção de análise geral
  md += `## 🎯 ANÁLISE GERAL\n\n`;
  md += `### Pontos Fortes\n\n`;
  md += `- [Preencher...]\n\n`;
  md += `### Pontos de Atenção\n\n`;
  md += `- [Preencher...]\n\n`;
  md += `### Prioridades de Correção\n\n`;
  md += `1. **P0 (Urgente):** [Preencher...]\n`;
  md += `2. **P1 (Alta):** [Preencher...]\n`;
  md += `3. **P2 (Média):** [Preencher...]\n\n`;
  md += `### Decisão Final\n\n`;
  md += `- [ ] **Aprovado para produção**\n`;
  md += `- [ ] **Aprovado com ressalvas**\n`;
  md += `- [ ] **Reprovado — necessita ajustes**\n\n`;
  md += `**Assinatura:** _________________________ **Data:** ___/___/______\n\n`;
  
  return md;
}

function gerarRelatorioJSON(resultados) {
  return JSON.stringify({
    metadata: {
      versao: 'Amanda FSM V8',
      dataGeracao: new Date().toISOString(),
      totalCenarios: resultados.length,
      crashes: resultados.filter(r => r.erro).length,
      respondidos: resultados.filter(r => r.respostaReal).length
    },
    resultados: resultados.map(r => ({
      id: r.id,
      nome: r.nome,
      categoria: r.categoria,
      statusEsperado: r.statusEsperado,
      leadPergunta: r.leadPergunta,
      amandaResposta: r.respostaReal,
      erro: r.erro ? r.erro.mensagem : null,
      tempoResposta: r.tempoResposta,
      timestamp: r.timestamp,
      criterios: r.criterios,
      problemaConhecido: r.problemaConhecido || null,
      respostaEsperadaIdeal: r.respostaEsperadaIdeal || null
    }))
  }, null, 2);
}

function printConsoleResumo(resultados) {
  console.log('\n' + '═'.repeat(70));
  console.log('💎 RELATÓRIO Q&A — RESUMO');
  console.log('═'.repeat(70) + '\n');
  
  resultados.forEach(r => {
    const icon = r.erro ? '💥' : (r.respostaReal ? '✅' : '❌');
    const status = r.erro ? 'CRASH' : (r.respostaReal ? 'OK' : 'VAZIO');
    console.log(`${icon} ${r.id} — ${r.nome}`);
    console.log(`   Status: ${status} | Tempo: ${r.tempoResposta}ms`);
    if (r.erro) {
      console.log(`   Erro: ${r.erro.mensagem.substring(0, 60)}...`);
    }
    console.log('');
  });
  
  console.log('═'.repeat(70));
  console.log(`Total: ${resultados.length} | OK: ${resultados.filter(r => r.respostaReal && !r.erro).length} | Erros: ${resultados.filter(r => r.erro).length}`);
  console.log('═'.repeat(70));
}

// ═══════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════

async function main() {
  console.log('💎 GERANDO RELATÓRIO Q&A — Amanda FSM V8\n');
  console.log(`📋 Total de cenários: ${CENARIOS.length}`);
  console.log('🔄 Conectando ao banco de dados...\n');

  await mongoose.connect(MONGO_URI);
  console.log('✅ Conectado!\n');
  console.log('⏳ Executando testes...\n');

  const resultados = [];
  
  for (let i = 0; i < CENARIOS.length; i++) {
    const cenario = CENARIOS[i];
    console.log(`  [${i + 1}/${CENARIOS.length}] Testando ${cenario.id}...`);
    
    const resultado = await testarCenario(cenario);
    resultados.push(resultado);
    
    if (resultado.erro) {
      console.log(`      💥 ERRO: ${resultado.erro.mensagem.substring(0, 50)}...`);
    } else {
      console.log(`      ✅ Respondido em ${resultado.tempoResposta}ms`);
    }
  }

  console.log('\n✅ Todos os cenários executados!\n');

  // Gera relatórios
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  
  // Relatório Markdown (formato humano)
  const relatorioMD = gerarRelatorioMarkdown(resultados);
  const filenameMD = `tests-amanda-ouro/RELATORIO-QNA-V8-${timestamp}.md`;
  fs.writeFileSync(path.join(process.cwd(), filenameMD), relatorioMD);
  
  // Relatório JSON (formato máquina)
  const relatorioJSON = gerarRelatorioJSON(resultados);
  const filenameJSON = `tests-amanda-ouro/RELATORIO-QNA-V8-${timestamp}.json`;
  fs.writeFileSync(path.join(process.cwd(), filenameJSON), relatorioJSON);

  // Resumo no console
  printConsoleResumo(resultados);

  console.log('\n📄 Arquivos gerados:');
  console.log(`   • ${filenameMD}`);
  console.log(`   • ${filenameJSON}`);

  await mongoose.disconnect();

  console.log('\n✨ Pronto! Abra o arquivo .md para análise completa.\n');
}

main().catch(err => {
  console.error('\n💥 ERRO FATAL:', err);
  process.exit(1);
});
