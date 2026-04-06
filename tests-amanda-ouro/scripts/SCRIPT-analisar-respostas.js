#!/usr/bin/env node
/**
 * 📊 ANALISADOR DE RESPOSTAS DA AMANDA
 * 
 * Analisa o relatório de testes do site e gera métricas
 * Uso: node SCRIPT-analisar-respostas.js [arquivo-relatorio.md]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Cores para terminal
const c = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m'
};

function log(color, msg) {
  console.log(`${color}${msg}${c.reset}`);
}

// Parser do relatório
function parseRelatorio(content) {
  const casos = [];
  const regex = /## \d+\.\s+(.+?)\s+—\s+(.+?)\n+\*\*👤 MENSAGEM DO SITE:\*\*\n```\n([\s\S]*?)```\n+\*\*🤖 RESPOSTA DA AMANDA:\*\*\n```\n([\s\S]*?)```/g;
  
  let match;
  while ((match = regex.exec(content)) !== null) {
    const [_, categoria, subcategoria, mensagem, resposta] = match;
    casos.push({
      categoria: categoria.trim(),
      subcategoria: subcategoria.trim(),
      mensagem: mensagem.trim(),
      resposta: resposta.trim()
    });
  }
  
  return casos;
}

// Classificador de respostas
function classificarResposta(caso) {
  const resposta = caso.resposta.toLowerCase();
  const mensagem = caso.mensagem.toLowerCase();
  
  // ERROS CRÍTICOS
  if (resposta.includes('erro:') || resposta.includes('incorrect api key')) {
    return { 
      status: '🔴 ERRO TÉCNICO', 
      problema: 'API key inválida ou erro técnico',
      gravidade: 'CRÍTICA'
    };
  }
  
  if (resposta.includes('fazer parte da nossa equipe') && 
      !mensagem.includes('trabalhar') && 
      !mensagem.includes('emprego') &&
      !mensagem.includes('vaga')) {
    return { 
      status: '🔴 PROBLEMA GRAVE', 
      problema: 'Confundiu paciente com candidato a emprego',
      gravidade: 'CRÍTICA'
    };
  }
  
  // Verifica se lead mencionou área específica
  const areasMencionadas = [];
  if (mensagem.includes('neuro')) areasMencionadas.push('neuropsicologia');
  if (mensagem.includes('fono')) areasMencionadas.push('fonoaudiologia');
  if (mensagem.includes('psico')) areasMencionadas.push('psicologia');
  if (mensagem.includes('fisio')) areasMencionadas.push('fisioterapia');
  if (mensagem.includes('to') || mensagem.includes('ocupacional')) areasMencionadas.push('terapia ocupacional');
  
  // Se mencionou área mas Amanda perguntou qual área
  if (areasMencionadas.length > 0 && 
      (resposta.includes('qual área') || resposta.includes('qual especialidade'))) {
    return { 
      status: '🔴 PROBLEMA', 
      problema: `Lead mencionou ${areasMencionadas[0]} mas Amanda perguntou qual área`,
      gravidade: 'ALTA'
    };
  }
  
  // Resposta genérica sem direcionamento
  if (resposta.includes('entendo sua preocupação') && 
      !resposta.includes('fonoaudiologia') &&
      !resposta.includes('psicologia') &&
      !resposta.includes('neuropsicologia') &&
      !resposta.includes('fisioterapia') &&
      !resposta.includes('terapia ocupacional') &&
      !resposta.includes('parece que')) {
    return { 
      status: '🟡 REGULAR', 
      problema: 'Empatia genérica sem direcionamento para área',
      gravidade: 'MÉDIA'
    };
  }
  
  // EXCELENTE: Detectou área e direcionou
  if ((resposta.includes('fonoaudiologia') ||
       resposta.includes('psicologia') ||
       resposta.includes('neuropsicologia') ||
       resposta.includes('fisioterapia') ||
       resposta.includes('terapia ocupacional') ||
       resposta.includes('musicoterapia')) &&
      (resposta.includes('qual o nome') || resposta.includes('qual nome'))) {
    return { 
      status: '🟢 EXCELENTE', 
      problema: null,
      gravidade: null
    };
  }
  
  // Sondagem adequada (neuropsicologia)
  if (resposta.includes('avaliação completa com laudo') || 
      resposta.includes('diagnóstico') ||
      resposta.includes('terapias')) {
    return { 
      status: '🟢 EXCELENTE', 
      problema: null,
      gravidade: null
    };
  }
  
  // Sugeriu área corretamente
  if (resposta.includes('parece que') && resposta.includes('pode ajudar')) {
    return { 
      status: '🟢 EXCELENTE', 
      problema: null,
      gravidade: null
    };
  }
  
  // 🎯 TEMPLATE OURO: Empatia + direcionamento + CTA
  if (resposta.includes('entendo sua preocupação') && 
      resposta.includes('pode ajudar bastante') &&
      (resposta.includes('fonoaudiologia') ||
       resposta.includes('psicologia') ||
       resposta.includes('neuropsicologia') ||
       resposta.includes('fisioterapia') ||
       resposta.includes('terapia ocupacional'))) {
    return { 
      status: '🟢 EXCELENTE', 
      problema: null,
      gravidade: null
    };
  }
  
  // Genérica mas aceitável
  if (resposta.includes('me conta o que você busca') ||
      resposta.includes('direciono para a especialidade')) {
    return { 
      status: '🟡 REGULAR', 
      problema: 'Resposta genérica quando poderia sugerir área',
      gravidade: 'BAIXA'
    };
  }
  
  // Endereço
  if (resposta.includes('av. minas gerais') || resposta.includes('maps')) {
    return { 
      status: '🟢 EXCELENTE', 
      problema: null,
      gravidade: null
    };
  }
  
  return { 
    status: '🟡 REGULAR', 
    problema: 'Classificação padrão - revisar manualmente',
    gravidade: 'BAIXA'
  };
}

// Agrupa por categoria
function agruparPorCategoria(casos) {
  const grupos = {};
  
  for (const caso of casos) {
    if (!grupos[caso.categoria]) {
      grupos[caso.categoria] = [];
    }
    grupos[caso.categoria].push(caso);
  }
  
  return grupos;
}

// Gera relatório
function gerarRelatorio(casos) {
  let excelente = 0, regular = 0, problema = 0, erro = 0;
  
  for (const caso of casos) {
    const classificacao = classificarResposta(caso);
    caso.classificacao = classificacao;
    
    if (classificacao.status.includes('EXCELENTE')) excelente++;
    else if (classificacao.status.includes('REGULAR')) regular++;
    else if (classificacao.status.includes('ERRO')) erro++;
    else problema++;
  }
  
  return { excelente, regular, problema, erro, total: casos.length };
}

// Main
async function main() {
  const arquivo = process.argv[2] || '../relatorios/RELATORIO-TESTE-SITE-FONO-INOVA-2026-03-28T02-00-18-575Z.md';
  const arquivoPath = path.resolve(__dirname, arquivo);
  
  if (!fs.existsSync(arquivoPath)) {
    log(c.red, `❌ Arquivo não encontrado: ${arquivoPath}`);
    process.exit(1);
  }
  
  log(c.cyan, '📊 ANALISADOR DE RESPOSTAS DA AMANDA V8\n');
  log(c.blue, `Arquivo: ${arquivo}\n`);
  
  const content = fs.readFileSync(arquivoPath, 'utf-8');
  const casos = parseRelatorio(content);
  
  log(c.bold, `Total de casos analisados: ${casos.length}\n`);
  
  // Estatísticas gerais
  const stats = gerarRelatorio(casos);
  
  log(c.green, `🟢 EXCELENTE: ${stats.excelente} (${Math.round(stats.excelente/stats.total*100)}%)`);
  log(c.yellow, `🟡 REGULAR: ${stats.regular} (${Math.round(stats.regular/stats.total*100)}%)`);
  log(c.red, `🔴 PROBLEMA: ${stats.problema} (${Math.round(stats.problema/stats.total*100)}%)`);
  log(c.red, `🔴 ERRO TÉCNICO: ${stats.erro} (${Math.round(stats.erro/stats.total*100)}%)`);
  
  console.log('');
  
  // Por categoria
  const grupos = agruparPorCategoria(casos);
  
  log(c.bold, '📋 POR CATEGORIA:\n');
  
  for (const [categoria, casosCat] of Object.entries(grupos)) {
    const statsCat = { excelente: 0, regular: 0, problema: 0, erro: 0 };
    
    for (const c of casosCat) {
      if (c.classificacao.status.includes('EXCELENTE')) statsCat.excelente++;
      else if (c.classificacao.status.includes('REGULAR')) statsCat.regular++;
      else if (c.classificacao.status.includes('ERRO')) statsCat.erro++;
      else statsCat.problema++;
    }
    
    const taxa = Math.round(statsCat.excelente / casosCat.length * 100);
    const cor = taxa >= 80 ? c.green : taxa >= 50 ? c.yellow : c.red;
    
    console.log(`${cor}${categoria.padEnd(20)} 🟢${statsCat.excelente} 🟡${statsCat.regular} 🔴${statsCat.problema+statsCat.erro} = ${taxa}%${c.reset}`);
  }
  
  console.log('');
  
  // Problemas críticos
  const criticos = casos.filter(c => 
    c.classificacao.gravidade === 'CRÍTICA' || 
    c.classificacao.gravidade === 'ALTA'
  );
  
  if (criticos.length > 0) {
    log(c.red, `🔴 PROBLEMAS CRÍTICOS (${criticos.length}):\n`);
    
    for (const c of criticos) {
      console.log(`${c.red}${c.classificacao.status}${c.reset} - ${c.subcategoria}`);
      console.log(`   Mensagem: "${c.mensagem.substring(0, 60)}..."`);
      console.log(`   Problema: ${c.classificacao.problema}\n`);
    }
  }
  
  // Salvar relatório detalhado
  const outputPath = path.join(__dirname, '../relatorios/ANALISE_AUTOMATICA.md');
  
  let md = `# 📊 Análise Automática - Amanda V8\n\n`;
  md += `**Gerado em:** ${new Date().toLocaleString('pt-BR')}\n`;
  md += `**Fonte:** ${arquivo}\n\n`;
  md += `## Resumo\n\n`;
  md += `- 🟢 EXCELENTE: ${stats.excelente} (${Math.round(stats.excelente/stats.total*100)}%)\n`;
  md += `- 🟡 REGULAR: ${stats.regular} (${Math.round(stats.regular/stats.total*100)}%)\n`;
  md += `- 🔴 PROBLEMA: ${stats.problema} (${Math.round(stats.problema/stats.total*100)}%)\n`;
  md += `- 🔴 ERRO: ${stats.erro} (${Math.round(stats.erro/stats.total*100)}%)\n\n`;
  md += `## Casos com Problemas\n\n`;
  
  for (const c of casos.filter(c => !c.classificacao.status.includes('EXCELENTE'))) {
    md += `### ${c.categoria} - ${c.subcategoria}\n\n`;
    md += `**Status:** ${c.classificacao.status}\n\n`;
    md += `**Mensagem:** ${c.mensagem}\n\n`;
    md += `**Resposta:** ${c.resposta}\n\n`;
    if (c.classificacao.problema) {
      md += `**Problema:** ${c.classificacao.problema}\n\n`;
    }
    md += `---\n\n`;
  }
  
  fs.writeFileSync(outputPath, md);
  log(c.green, `✅ Relatório salvo em: ${outputPath}`);
}

main().catch(console.error);
