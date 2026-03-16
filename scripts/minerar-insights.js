#!/usr/bin/env node
/**
 * 💎 Minerador de Insights de Conversas
 * 
 * Analisa as 40k conversas para encontrar padrões de:
 * - Mensagens que geraram conversões
 * - Mensagens que geraram desistências
 * - Padrões de linguagem que funcionam/não funcionam
 * - Comportamentos críticos da Amanda
 * 
 * Gera relatório para melhorar as respostas.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONVERSAS_DIR = path.join(__dirname, 'amanda');
const MINED_DIR = path.join(__dirname, '..', 'back', 'config', 'mined-patterns');

// ============================================
// 📊 CONTADORES
// ============================================
const stats = {
  total: 0,
  comConversao: 0,
  comDesistencia: 0,
  objecoes: {},
  gatilhosConversao: [],
  gatilhosDesistencia: [],
  frasesAmandaBemSucedidas: [],
  frasesAmandaFalhas: [],
  areas: {},
  idades: {},
  contextoPerdido: 0
};

// ============================================
// 🔍 PATTERNS
// ============================================
const PATTERNS = {
  conversao: /\b(agendou|marca(ram)?|confirm(ou|amos)|vai vir|comparecer|pacote|assinou)\b/i,
  desistencia: /\b(desistiu|não respondeu|parou|tá caro|não vou|pensar|depois|não posso)\b/i,
  objecaoPreco: /\b(car(o|a)|preço|valor|custo|dinheiro|não tenho|2000|mil)\b/i,
  objecaoTempo: /\b(não tenho tempo|ocupado|corrido|não consigo|horário)\b/i,
  objecaoLocal: /\b(longe|distância|não moro|transporte|difícil chegar)\b/i,
  contextoPerdido: /\b(repetiu|já tinha perguntado|já disse|perguntou de novo)\b/i,
  nomeExtraido: /\b(é\s+\w+|chama\s+\w+|nome\s+é?\s*\w+)\b/i,
  idadeExtraida: /\b(\d+)\s*(anos?|a)\b/i
};

// ============================================
// 🧠 ANALISADOR
// ============================================
function analisarConversa(conversa) {
  const resultado = {
    converteu: false,
    desistiu: false,
    objecoes: [],
    contextoPerdido: false,
    frasesEfetivas: [],
    frasesProblematicas: [],
    entidadesColetadas: { nome: false, idade: false, area: false, queixa: false },
    resumo: conversa.analysis?.resumo || ''
  };
  
  const resumoLower = resultado.resumo.toLowerCase();
  
  // Classifica conversa
  if (PATTERNS.conversao.test(resumoLower)) {
    resultado.converteu = true;
    stats.comConversao++;
  }
  if (PATTERNS.desistencia.test(resumoLower)) {
    resultado.desistiu = true;
    stats.comDesistencia++;
  }
  
  // Detecta objeções
  if (PATTERNS.objecaoPreco.test(resumoLower)) {
    resultado.objecoes.push('preco');
    stats.objecoes.preco = (stats.objecoes.preco || 0) + 1;
  }
  if (PATTERNS.objecaoTempo.test(resumoLower)) {
    resultado.objecoes.push('tempo');
    stats.objecoes.tempo = (stats.objecoes.tempo || 0) + 1;
  }
  if (PATTERNS.objecaoLocal.test(resumoLower)) {
    resultado.objecoes.push('local');
    stats.objecoes.local = (stats.objecoes.local || 0) + 1;
  }
  
  // Contexto perdido
  if (PATTERNS.contextoPerdido.test(resumoLower)) {
    resultado.contextoPerdido = true;
    stats.contextoPerdido++;
  }
  
  // Analisa mensagens individuais
  const msgs = conversa.messages || [];
  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];
    const texto = msg.text || '';
    
    // Detecta entidades coletadas
    if (msg.isUser) {
      if (PATTERNS.nomeExtraido.test(texto)) resultado.entidadesColetadas.nome = true;
      if (PATTERNS.idadeExtraida.test(texto)) resultado.entidadesColetadas.idade = true;
      if (/\b(fono|psi|to|fisio|neuro)\b/i.test(texto)) resultado.entidadesColetadas.area = true;
      if (PATTERNS.objecaoPreco.test(texto)) resultado.entidadesColetadas.queixa = true;
    }
    
    // Mensagens da Amanda
    if (!msg.isUser && i > 0) {
      const msgAnterior = msgs[i-1];
      
      // Se converteu logo depois, marca como efetiva
      if (resultado.converteu && i > msgs.length - 3) {
        resultado.frasesEfetivas.push(texto.substring(0, 100));
      }
      
      // Se usuário parou de responder depois
      if (resultado.desistiu && i > msgs.length - 3) {
        resultado.frasesProblematicas.push(texto.substring(0, 100));
      }
    }
  }
  
  return resultado;
}

// ============================================
// 📦 CARREGADOR
// ============================================
async function carregarConversas() {
  const conversas = [];
  
  try {
    const arquivos = await fs.readdir(CONVERSAS_DIR);
    const jsonFiles = arquivos.filter(f => f.endsWith('.json'));
    
    console.log(`📂 Total de arquivos: ${jsonFiles.length}`);
    console.log('🔄 Analisando (isso pode levar alguns minutos)...\n');
    
    // Processa em lotes
    const BATCH_SIZE = 1000;
    for (let i = 0; i < jsonFiles.length; i += BATCH_SIZE) {
      const lote = jsonFiles.slice(i, i + BATCH_SIZE);
      
      for (const arquivo of lote) {
        try {
          const conteudo = await fs.readFile(path.join(CONVERSAS_DIR, arquivo), 'utf-8');
          const dados = JSON.parse(conteudo);
          conversas.push(dados);
        } catch (e) {
          // Ignora erros de parsing
        }
      }
      
      if (Math.floor(i / BATCH_SIZE) % 10 === 0) {
        process.stdout.write(`  Processados: ${Math.min(i + BATCH_SIZE, jsonFiles.length)}\r`);
      }
    }
  } catch (e) {
    console.log(`❌ Erro: ${e.message}`);
  }
  
  return conversas;
}

// ============================================
// 📊 RELATÓRIO
// ============================================
async function gerarRelatorio(analises) {
  console.log('\n\n' + '='.repeat(70));
  console.log('📊 RELATÓRIO DE INSIGHTS');
  console.log('='.repeat(70));
  
  // Taxa de conversão
  const taxaConversao = (stats.comConversao / stats.total * 100).toFixed(1);
  const taxaDesistencia = (stats.comDesistencia / stats.total * 100).toFixed(1);
  
  console.log(`\n📈 Conversões: ${stats.comConversao} (${taxaConversao}%)`);
  console.log(`📉 Desistências: ${stats.comDesistencia} (${taxaDesistencia}%)`);
  console.log(`🔁 Contexto perdido: ${stats.contextoPerdido} vezes`);
  
  // Objeções
  console.log(`\n💰 Objeções mais comuns:`);
  const objecoesOrdenadas = Object.entries(stats.objecoes)
    .sort((a, b) => b[1] - a[1]);
  objecoesOrdenadas.forEach(([tipo, count]) => {
    const pct = (count / stats.total * 100).toFixed(1);
    console.log(`   ${tipo}: ${count} (${pct}%)`);
  });
  
  // Padrões de resposta bem-sucedidos
  console.log(`\n✅ Frases da Amanda que geraram conversão:`);
  const frasesEfetivas = analises
    .filter(a => a.converteu)
    .flatMap(a => a.frasesEfetivas)
    .filter(f => f.length > 20)
    .slice(0, 10);
  
  frasesEfetivas.forEach((f, i) => {
    console.log(`   ${i+1}. "${f}..."`);
  });
  
  // Problemas
  console.log(`\n❌ Frases da Amanda que precederam desistência:`);
  const frasesFalhas = analises
    .filter(a => a.desistiu && !a.converteu)
    .flatMap(a => a.frasesProblematicas)
    .filter(f => f.length > 20)
    .slice(0, 10);
  
  frasesFalhas.forEach((f, i) => {
    console.log(`   ${i+1}. "${f}..."`);
  });
  
  // Salva relatório completo
  await fs.mkdir(MINED_DIR, { recursive: true });
  
  const timestamp = new Date().toISOString().split('T')[0];
  const relatorioPath = path.join(MINED_DIR, `insights-${timestamp}.json`);
  
  const relatorio = {
    gerado: new Date().toISOString(),
    estatisticas: {
      total: stats.total,
      conversoes: stats.comConversao,
      desistencias: stats.comDesistencia,
      taxaConversao: parseFloat(taxaConversao),
      contextoPerdido: stats.contextoPerdido
    },
    objecoes: stats.objecoes,
    frasesEfetivas,
    frasesFalhas,
    insights: {
      topObjecoes: objecoesOrdenadas.slice(0, 3).map(([k]) => k),
      problemaContexto: stats.contextoPerdido > stats.total * 0.05
    }
  };
  
  await fs.writeFile(relatorioPath, JSON.stringify(relatorio, null, 2));
  console.log(`\n💾 Relatório salvo: ${relatorioPath}`);
  
  // Recomendações
  console.log(`\n💡 RECOMENDAÇÕES:`);
  if (stats.contextoPerdido > 100) {
    console.log(`   ⚠️ Contexto sendo perdido frequentemente - revisar leadContext.js`);
  }
  if (stats.objecoes.preco > stats.comConversao) {
    console.log(`   💰 Muitas objeções de preço - criar script de manejo de preço`);
  }
  console.log(`   🎯 Focar em recuperar contexto de nome/idade entre mensagens`);
}

// ============================================
// 🚀 MAIN
// ============================================
async function main() {
  console.log('💎 Minerador de Insights de Conversas\n');
  
  const conversas = await carregarConversas();
  stats.total = conversas.length;
  
  console.log(`\n✅ ${conversas.length} conversas carregadas`);
  console.log('🔍 Analisando padrões...\n');
  
  const analises = [];
  for (const conversa of conversas) {
    const analise = analisarConversa(conversa);
    analises.push(analise);
  }
  
  await gerarRelatorio(analises);
  
  console.log('\n🎉 Análise completa!');
}

main().catch(console.error);
