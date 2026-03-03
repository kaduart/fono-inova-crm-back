#!/usr/bin/env node
/**
 * 🎯 Executor de Testes de Conversas Reais
 * 
 * Roda cenários de conversas reais e avalia as respostas da Amanda
 * 
 * Uso:
 *   node executar-testes.js --cenario=fluxos-completos/fluxo-fono.json
 *   node executar-testes.js --all
 *   node executar-testes.js --interativo
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import { getOptimizedAmandaResponse } from '../../orchestrators/AmandaOrchestrator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Cores
const C = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m'
};

// ============================================
// 🎮 CARREGADOR DE CENÁRIOS
// ============================================
async function carregarCenarios() {
  const cenarios = [];
  
  const pastas = ['fluxos-completos', 'cenarios-criticos', 'edge-cases'];
  
  for (const pasta of pastas) {
    const pastaPath = path.join(__dirname, pasta);
    try {
      const arquivos = await fs.readdir(pastaPath);
      for (const arquivo of arquivos) {
        if (arquivo.endsWith('.json')) {
          const filePath = path.join(pastaPath, arquivo);
          const conteudo = await fs.readFile(filePath, 'utf-8');
          const cenario = JSON.parse(conteudo);
          cenario._arquivo = arquivo;
          cenario._pasta = pasta;
          cenarios.push(cenario);
        }
      }
    } catch (err) {
      console.log(`${C.yellow}⚠️ Pasta ${pasta} não encontrada ou vazia${C.reset}`);
    }
  }
  
  return cenarios;
}

// ============================================
// 🧪 AVALIADOR
// ============================================
function avaliarResposta(resposta, esperado, contexto) {
  const checks = [];
  let score = 0;
  let maxScore = 0;
  
  // Verifica conteúdo esperado
  if (esperado.respostaContem) {
    for (const termo of esperado.respostaContem) {
      maxScore += 2;
      const encontrado = resposta.toLowerCase().includes(termo.toLowerCase());
      checks.push({ nome: `Contém "${termo}"`, passou: encontrado, peso: 2 });
      if (encontrado) score += 2;
    }
  }
  
  // Verifica conteúdo que NÃO deve ter
  if (esperado.naoDeveConter) {
    for (const termo of esperado.naoDeveConter) {
      maxScore += 2;
      const encontrado = !resposta.toLowerCase().includes(termo.toLowerCase());
      checks.push({ nome: `NÃO contém "${termo}"`, passou: encontrado, peso: 2 });
      if (encontrado) score += 2;
    }
  }
  
  // Verifica empatia
  if (esperado.empatia) {
    maxScore += 3;
    const temEmpatia = /\b(entendo|compreendo|sei|imagino|deve ser|difícil|preocupação)\b/i.test(resposta);
    checks.push({ nome: 'Mostra empatia', passou: temEmpatia, peso: 3 });
    if (temEmpatia) score += 3;
  }
  
  // Verifica se não é agressivo
  if (esperado.naoPressiona !== undefined) {
    maxScore += 2;
    const pressao = /\b(corre|rápido|agora|só hoje|última chance|vai acabar)\b/i.test(resposta);
    checks.push({ nome: 'Não pressiona', passou: !pressao, peso: 2 });
    if (!pressao) score += 2;
  }
  
  // Verifica personalização
  if (esperado.personalizacao && contexto.patientInfo?.fullName) {
    maxScore += 2;
    const primeiroNome = contexto.patientInfo.fullName.split(' ')[0];
    const personalizou = resposta.includes(primeiroNome);
    checks.push({ nome: 'Personaliza com nome', passou: personalizou, peso: 2 });
    if (personalizou) score += 2;
  }
  
  // Verifica contexto recuperado
  if (esperado.contextoRecuperado) {
    for (const item of esperado.contextoRecuperado) {
      maxScore += 2;
      const recuperado = resposta.toLowerCase().includes(item.toLowerCase());
      checks.push({ nome: `Recupera contexto: "${item}"`, passou: recuperado, peso: 2 });
      if (recuperado) score += 2;
    }
  }
  
  const scoreNormalizado = maxScore > 0 ? (score / maxScore) * 10 : 5;
  const passou = scoreNormalizado >= (esperado.scoreMinimo || 6);
  
  return {
    score: scoreNormalizado,
    passou,
    checks,
    resumo: `Score: ${scoreNormalizado.toFixed(1)}/10`
  };
}

// ============================================
// 🚀 EXECUTOR DE CENÁRIO
// ============================================
async function executarCenario(cenario, interativo = false) {
  console.log(`\n${C.cyan}${'='.repeat(70)}${C.reset}`);
  console.log(`${C.cyan}🎮 ${cenario.nome}${C.reset}`);
  console.log(`${C.cyan}${cenario.descricao}${C.reset}`);
  console.log(`${C.cyan}Arquivo: ${cenario._pasta}/${cenario._arquivo}${C.reset}`);
  console.log(`${C.cyan}${'='.repeat(70)}${C.reset}`);
  
  // Cria lead mock
  let lead = {
    _id: new mongoose.Types.ObjectId(),
    name: 'Responsável Teste',
    contact: { phone: '5561999999999' },
    ...cenario.leadInicial,
    patientInfo: { ...cenario.leadInicial.patientInfo }
  };
  
  const resultadosTurnos = [];
  
  for (const msg of cenario.mensagens) {
    console.log(`\n${C.blue}📨 ${msg.ordem}. Usuário: "${msg.texto}"${C.reset}`);
    
    if (interativo) {
      console.log('   (pressione ENTER para ver resposta da Amanda)');
      await new Promise(r => process.stdin.once('data', r));
    }
    
    try {
      const resposta = await getOptimizedAmandaResponse({
        content: msg.texto,
        userText: msg.texto,
        lead,
        context: {}
      });
      
      console.log(`${C.green}🤖 Amanda: "${resposta?.substring(0, 100)}..."${C.reset}`);
      
      const avaliacao = avaliarResposta(resposta, msg.esperado, lead);
      
      // Cor
      const cor = avaliacao.score >= 8 ? C.green : avaliacao.score >= 6 ? C.yellow : C.red;
      console.log(`   ${cor}${avaliacao.resumo}${C.reset}`);
      
      // Mostra falhas
      const falhas = avaliacao.checks.filter(c => !c.passou);
      if (falhas.length > 0) {
        console.log(`   ${C.red}❌ Falhas:${C.reset}`);
        falhas.forEach(f => console.log(`      - ${f.nome}`));
      }
      
      // Crítico
      if (msg.esperado.critico && !avaliacao.passou) {
        console.log(`   ${C.red}${C.bold}⚠️  CENÁRIO CRÍTICO FALHOU!${C.reset}`);
      }
      
      resultadosTurnos.push({
        ordem: msg.ordem,
        texto: msg.texto,
        avaliacao,
        resposta: resposta?.substring(0, 150)
      });
      
    } catch (erro) {
      console.error(`   ${C.red}❌ Erro: ${erro.message}${C.reset}`);
      resultadosTurnos.push({ ordem: msg.ordem, texto: msg.texto, erro: erro.message });
    }
  }
  
  const scoreMedio = resultadosTurnos
    .filter(r => r.avaliacao)
    .reduce((a, r) => a + r.avaliacao.score, 0) / resultadosTurnos.length || 0;
  
  return {
    cenario: cenario.nome,
    arquivo: cenario._arquivo,
    scoreMedio,
    passou: scoreMedio >= 6,
    turnos: resultadosTurnos
  };
}

// ============================================
// 📊 RELATÓRIO
// ============================================
async function gerarRelatorio(resultados) {
  console.log(`\n${C.cyan}${'='.repeat(70)}${C.reset}`);
  console.log(`${C.cyan}📊 RELATÓRIO FINAL${C.reset}`);
  console.log(`${C.cyan}${'='.repeat(70)}${C.reset}`);
  
  const scoreGeral = resultados.reduce((a, r) => a + r.scoreMedio, 0) / resultados.length;
  const aprovados = resultados.filter(r => r.passou).length;
  
  console.log(`\n📈 Score Geral: ${scoreGeral.toFixed(1)}/10`);
  console.log(`✅ Cenários aprovados: ${aprovados}/${resultados.length}`);
  
  console.log(`\n🏆 Ranking:`);
  resultados
    .sort((a, b) => b.scoreMedio - a.scoreMedio)
    .forEach((r, i) => {
      const cor = r.scoreMedio >= 8 ? C.green : r.scoreMedio >= 6 ? C.yellow : C.red;
      console.log(`   ${i+1}. ${cor}${r.cenario}: ${r.scoreMedio.toFixed(1)}/10${C.reset}`);
    });
  
  // Salva JSON
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(__dirname, `relatorio-${timestamp}.json`);
  await fs.writeFile(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    scoreGeral,
    aprovados,
    total: resultados.length,
    resultados
  }, null, 2));
  
  console.log(`\n💾 Relatório salvo: ${reportPath}`);
  
  return { scoreGeral, aprovados, total: resultados.length };
}

// ============================================
// 🚀 MAIN
// ============================================
async function main() {
  console.log(`${C.cyan}${C.bold}`);
  console.log('🎯 TESTES DE CONVERSAS REAIS - Amanda AI');
  console.log('Validando respostas com cenários do mundo real');
  console.log(`${C.reset}\n`);
  
  // Parse args
  const args = process.argv.slice(2);
  const modoInterativo = args.includes('--interativo');
  const rodarTodos = args.includes('--all');
  const cenarioEspecifico = args.find(a => a.startsWith('--cenario='))?.split('=')[1];
  
  try {
    // Conecta MongoDB
    console.log('🔌 Conectando ao MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/clinica');
    console.log(`${C.green}✅ Conectado${C.reset}\n`);
    
    // Carrega cenários
    const todosCenarios = await carregarCenarios();
    console.log(`${C.cyan}📂 ${todosCenarios.length} cenários carregados${C.reset}\n`);
    
    // Filtra cenários
    let cenariosParaRodar = todosCenarios;
    if (cenarioEspecifico) {
      cenariosParaRodar = todosCenarios.filter(c => 
        c._arquivo === cenarioEspecifico || 
        `${c._pasta}/${c._arquivo}` === cenarioEspecifico
      );
    }
    
    if (cenariosParaRodar.length === 0) {
      console.log(`${C.red}❌ Nenhum cenário encontrado${C.reset}`);
      process.exit(1);
    }
    
    // Executa
    const resultados = [];
    for (const cenario of cenariosParaRodar) {
      const resultado = await executarCenario(cenario, modoInterativo);
      resultados.push(resultado);
    }
    
    // Relatório
    await gerarRelatorio(resultados);
    
  } catch (erro) {
    console.error(`${C.red}❌ Erro: ${erro.message}${C.reset}`);
    console.error(erro.stack);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(console.error);
