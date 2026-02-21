#!/usr/bin/env node
/**
 * 🎭 SIMULADOR DE CONVERSAS REAIS COM A AMANDA
 * 
 * Simula conversas baseadas em casos reais de atendimento humano
 * Permite ver como Amanda responde vs. como humano respondeu
 * 
 * Uso: node tests/amanda/simulador-real.js [cenario-id]
 * 
 * Exemplos:
 *   node tests/amanda/simulador-real.js           # Lista cenários disponíveis
 *   node tests/amanda/simulador-real.js MC-01     # Simula caso de múltiplas crianças
 *   node tests/amanda/simulador-real.js DC-01     # Simula caso de desistência
 *   node tests/amanda/simulador-real.js interativo # Modo conversa livre
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { getOptimizedAmandaResponse } from '../../orchestrators/AmandaOrchestrator.js';
import Leads from '../../models/Leads.js';
import readline from 'readline';

const PHONE_TESTE = '5562999999998';

// ═══════════════════════════════════════════════════════════
// CENÁRIOS REAIS BASEADOS EM CONVERSAS HUMANAS
// ═══════════════════════════════════════════════════════════

const CENARIOS = {
  'MC-01': {
    nome: 'Múltiplas Crianças - Dayene',
    descricao: 'Mãe com 2 filhos (Pedro 6 anos TEA + Thiago 8 anos TDAH)',
    contexto: 'Conversa real onde a mãe perguntou sobre avaliação para os dois',
    conversaHumana: [
      { autor: 'Cliente', texto: 'Oi, tenho dois filhos que precisam de avaliação' },
      { autor: 'Humano', texto: 'Oi! Que bom que você entrou em contato 💚 Me conta: qual a idade deles e o que está acontecendo?' },
      { autor: 'Cliente', texto: 'Pedro tem 6 anos e tem laudo de TEA, Thiago tem 8 e tem TDAH' },
      { autor: 'Humano', texto: 'Entendo... Deve ser desafiador cuidar de dois com necessidades diferentes 💚 Vocês estão buscando qual terapia?' },
      { autor: 'Cliente', texto: 'Preciso de avaliação para os dois na terapia ocupacional' }
    ],
    expectativa: 'Deve detectar múltiplas crianças, mencionar desconto, não perguntar idade novamente'
  },

  'DC-01': {
    nome: 'Desistência - Lavínia',
    descricao: 'Mãe precisa remarcar porque não recebeu para pagar',
    contexto: 'Cliente pediu para remarcar após confirmação por questões financeiras',
    conversaHumana: [
      { autor: 'Amanda', texto: 'Confirmado! A sessão está agendada para amanhã às 10h 💚' },
      { autor: 'Cliente', texto: 'Minha mãe ainda não recebeu para pagar, pode remarcar?' }
    ],
    expectativa: 'Deve ser empática, oferecer remarcação sem cobrar, não pressionar'
  },

  'CH-01': {
    nome: 'Confusão de Dia - Mariluiza',
    descricao: 'Cliente confundiu terça-feira com segunda-feira',
    contexto: 'Após confirmação, cliente disse "Hj segunda feira né" quando era terça',
    conversaHumana: [
      { autor: 'Amanda', texto: 'Confirmado: Terça-feira, dia 14/01 às 14h 💚' },
      { autor: 'Cliente', texto: 'Hj segunda feira né, confirmado' }
    ],
    expectativa: 'Deve corrigir gentilmente, confirmar que é terça, não deixar passar'
  },

  'PL-01': {
    nome: 'Pergunta Plano no Início - Thiago',
    descricao: 'Cliente pergunta sobre plano de saúde antes de qualificar',
    contexto: 'Primeira mensagem já perguntando sobre fonoaudiólogos e Unimed',
    conversaHumana: [
      { autor: 'Cliente', texto: 'Por gentileza, quais fonoaudiólogos trabalham com vocês e atendem Unimed?' }
    ],
    expectativa: 'Deve explicar sobre reembolso, não salvar como queixa principal, qualificar depois'
  },

  'SA-01': {
    nome: 'Pedido de Sábado',
    descricao: 'Cliente quer agendar para sábado mas clínica não atende',
    contexto: 'Cliente pede sábado e precisa ser direcionado para segunda',
    conversaHumana: [
      { autor: 'Cliente', texto: 'Vocês atendem de sábado?' }
    ],
    expectativa: 'Deve informar que não atende sábado, oferecer segunda, não ser negativo'
  },

  'FO-01': {
    nome: 'Fono Adulto - Sara',
    descricao: 'Adulto procurando fonoaudiologia (não é criança)',
    contexto: 'Sara perguntou se atende adultos para fonoaudiologia',
    conversaHumana: [
      { autor: 'Cliente', texto: 'Bom dia, vocês atendem adultos na fonoaudiologia?' },
      { autor: 'Humano', texto: 'Sara, atendemos sim adultos, o fonoaudiólogo trabalha para melhorar a clareza e precisão da fala...' }
    ],
    expectativa: 'Deve confirmar que atende adultos, explicar o trabalho, não pressupor criança'
  },

  'IN-01': {
    nome: 'Investigação TEA - Mãe preocupada',
    descricao: 'Mãe suspeita de TEA mas não tem laudo',
    contexto: 'Mãe descreve comportamentos sem dizer explicitamente TEA',
    conversaHumana: [
      { autor: 'Cliente', texto: 'Oi, meu filho de 3 anos não olha nos olhos e não responde quando chamamos. Preciso de ajuda' }
    ],
    expectativa: 'Deve acolher com empatia, sugerir avaliação multidisciplinar, não diagnosticar'
  },

  'RE-01': {
    nome: 'Remarcação Doença - DC-04',
    descricao: 'Cliente doente precisa remarcar sem custo',
    contexto: 'Cliente avisa que está doente e precisa remarcar',
    conversaHumana: [
      { autor: 'Cliente', texto: 'Bom dia, estou com virose e não vou conseguir ir hoje. Pode remarcar?' }
    ],
    expectativa: 'Deve desejar melhoras, remarcar sem taxa, ser acolhedora'
  }
};

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════

function printBanner() {
  console.log('\n🎭 ═══════════════════════════════════════════════════════════');
  console.log('   SIMULADOR DE CONVERSAS REAIS - AMANDA AI');
  console.log('   Compare respostas da Amanda com atendimento humano');
  console.log('═══════════════════════════════════════════════════════════ 🎭\n');
}

function printCenario(key, cenario) {
  console.log(`\n📋 ${key}: ${cenario.nome}`);
  console.log(`   ${cenario.descricao}`);
  console.log(`   Contexto: ${cenario.contexto}`);
  console.log(`   Expectativa: ${cenario.expectativa}\n`);
}

async function limparLeadTeste() {
  await Leads.deleteOne({ 'contact.phone': PHONE_TESTE });
}

async function criarLeadInicial(phone, nome = 'Lead Teste') {
  await limparLeadTeste();
  const lead = new Leads({
    contact: { phone },
    name: nome,
    patientInfo: {},
    stage: 'novo',
    createdAt: new Date()
  });
  await lead.save();
  return lead;
}

async function enviarMensagem(lead, texto, historico = []) {
  const context = {
    stage: lead.stage || 'novo',
    messageCount: historico.length,
    conversationHistory: historico.map(h => ({
      role: h.autor === 'Cliente' ? 'user' : 'assistant',
      content: h.texto
    })),
    phone: PHONE_TESTE
  };

  try {
    const resposta = await getOptimizedAmandaResponse({
      content: texto,
      userText: texto,
      lead: lead,
      context: context
    });
    return resposta;
  } catch (error) {
    console.error('❌ Erro:', error.message);
    return { text: '[ERRO: ' + error.message + ']', error: true };
  }
}

// ═══════════════════════════════════════════════════════════
// MODO INTERATIVO
// ═══════════════════════════════════════════════════════════

async function modoInterativo() {
  printBanner();
  console.log('🎮 Modo Interativo - Converse com a Amanda\n');
  console.log('Digite suas mensagens (ou "sair" para encerrar)\n');

  await mongoose.connect(process.env.MONGO_URI);
  let lead = await criarLeadInicial(PHONE_TESTE, 'Lead Interativo');
  let historico = [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const perguntar = () => {
    return new Promise((resolve) => {
      rl.question('👤 Você: ', resolve);
    });
  };

  while (true) {
    const mensagem = await perguntar();
    
    if (mensagem.toLowerCase() === 'sair') {
      console.log('\n👋 Encerrando conversa...');
      rl.close();
      break;
    }

    console.log('⏳ Amanda está digitando...\n');
    
    const resposta = await enviarMensagem(lead, mensagem, historico);
    
    historico.push({ autor: 'Cliente', texto: mensagem });
    historico.push({ autor: 'Amanda', texto: resposta.text || resposta });
    
    console.log(`🤖 Amanda: ${resposta.text || resposta}\n`);
  }

  await mongoose.disconnect();
}

// ═══════════════════════════════════════════════════════════
// MODO CENÁRIO
// ═══════════════════════════════════════════════════════════

async function executarCenario(cenarioKey) {
  const cenario = CENARIOS[cenarioKey];
  if (!cenario) {
    console.log(`❌ Cenário ${cenarioKey} não encontrado`);
    return;
  }

  printBanner();
  printCenario(cenarioKey, cenario);

  await mongoose.connect(process.env.MONGO_URI);
  let lead = await criarLeadInicial(PHONE_TESTE, cenario.nome);
  let historico = [];

  console.log('═══════════════════════════════════════════════════════════');
  console.log('🎬 INÍCIO DA SIMULAÇÃO\n');

  for (const mensagem of cenario.conversaHumana) {
    if (mensagem.autor === 'Cliente') {
      console.log(`👤 Cliente: ${mensagem.texto}`);
      
      console.log('⏳ Amanda processando...');
      const resposta = await enviarMensagem(lead, mensagem.texto, historico);
      
      console.log(`🤖 Amanda: ${resposta.text || resposta}\n`);
      
      historico.push({ autor: 'Cliente', texto: mensagem.texto });
      historico.push({ autor: 'Amanda', texto: resposta.text || resposta });
      
      // Comparação com resposta humana (se existir na conversa)
      const proximaHumana = cenario.conversaHumana.find((m, i) => 
        cenario.conversaHumana.indexOf(mensagem) < i && m.autor === 'Humano'
      );
      
      if (proximaHumana) {
        console.log(`📚 Humano: ${proximaHumana.texto}`);
        console.log('   ^^^ Resposta real do atendimento humano\n');
      }
      
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log('✅ SIMULAÇÃO CONCLUÍDA');
  console.log(`\n📝 Expectativa: ${cenario.expectativa}`);
  
  await mongoose.disconnect();
}

// ═══════════════════════════════════════════════════════════
// LISTAR CENÁRIOS
// ═══════════════════════════════════════════════════════════

function listarCenarios() {
  printBanner();
  console.log('📚 CENÁRIOS DISPONÍVEIS:\n');
  
  Object.entries(CENARIOS).forEach(([key, cenario]) => {
    console.log(`   ${key.padEnd(6)} - ${cenario.nome}`);
    console.log(`          ${cenario.descricao}`);
    console.log();
  });
  
  console.log('═══════════════════════════════════════════════════════════');
  console.log('Uso: node simulador-real.js [CENÁRIO]');
  console.log('Ex:  node simulador-real.js MC-01');
  console.log('     node simulador-real.js interativo');
}

// ═══════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════

async function main() {
  const arg = process.argv[2];

  if (!arg || arg === '--help' || arg === '-h') {
    listarCenarios();
    return;
  }

  if (arg === 'interativo' || arg === '-i') {
    await modoInterativo();
    return;
  }

  if (CENARIOS[arg]) {
    await executarCenario(arg);
    return;
  }

  console.log(`❌ Cenário "${arg}" não encontrado`);
  listarCenarios();
}

main().catch(err => {
  console.error('❌ Erro:', err);
  process.exit(1);
});
