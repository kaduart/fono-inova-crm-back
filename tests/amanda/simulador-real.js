#!/usr/bin/env node
/**
 * 🎭 SIMULADOR DE CONVERSAS REAIS COM A AMANDA
 *
 * Simula conversas baseadas em casos reais de atendimento humano
 * Permite ver como Amanda responde vs. como humano respondeu
 *
 * Uso: node tests/amanda/simulador-real.js [cenario-id] [--quiet] [--fsm]
 *
 * Exemplos:
 *   node tests/amanda/simulador-real.js               # Lista cenários disponíveis
 *   node tests/amanda/simulador-real.js MC-01         # Simula (legacy)
 *   node tests/amanda/simulador-real.js MC-01 --fsm   # Simula (nova FSM V8)
 *   node tests/amanda/simulador-real.js MC-01 --quiet # Sem logs internos
 *   node tests/amanda/simulador-real.js interativo    # Modo conversa livre
 *   node tests/amanda/simulador-real.js interativo --fsm  # Conversa livre na FSM
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { getOptimizedAmandaResponse } from '../../orchestrators/AmandaOrchestrator.js';
import WhatsAppOrchestrator from '../../orchestrators/WhatsAppOrchestrator.js';
import Leads from '../../models/Leads.js';
import readline from 'readline';

// --fsm usa a nova arquitetura WhatsAppOrchestrator (FSM V8)
const USE_FSM = process.argv.includes('--fsm');

// --quiet suprime logs internos do orchestrator
const QUIET = process.argv.includes('--quiet') || process.argv.includes('-q');
if (QUIET) {
  const noop = () => {};
  console.log = noop;
  console.warn = noop;
  console.info = noop;
  console.debug = noop;
  console.error = noop;
}

// print() escreve direto no stdout — nunca suprimido pelo --quiet
const print = (...args) => process.stdout.write(args.join(' ') + '\n');

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
  },

  // ── CENÁRIOS EXTRAÍDOS DE CONVERSAS REAIS (dados minados 2026) ──

  'RL-01': {
    nome: 'Urgência + Preço + Sem Plano',
    descricao: 'Lead chegou com urgência, sem plano e perguntando preço junto',
    contexto: 'Mensagem real extraída do export WhatsApp 2026',
    conversaHumana: [
      { autor: 'Cliente', texto: 'olá! tenho interesse e queria mais informações, por favor.' },
      { autor: 'Cliente', texto: 'tenho um filho de 6 anos que precisava urgentemente de acompanhamento fonoaudiologo, como faço? não tenho plano de saúde. valor das consultas' }
    ],
    expectativa: 'Deve acolher urgência, explicar avaliação, informar valor R$200 sem ser frio'
  },

  'RL-02': {
    nome: 'Plano de Saúde Logo no Início',
    descricao: 'Lead pergunta sobre plano antes de qualquer qualificação',
    contexto: 'Padrão frequente: 9 ocorrências no export 2026',
    conversaHumana: [
      { autor: 'Cliente', texto: 'Vocês atendem plano ou só particular?' },
      { autor: 'Humano', texto: 'No momento somente particular. Gostaria de conhecer nossos valores?' }
    ],
    expectativa: 'Deve explicar que é particular, mencionar reembolso Unimed, não encerrar conversa'
  },

  'RL-03': {
    nome: 'Fluxo Completo Real - Fono',
    descricao: 'Lead começa vago, informa terapia, pede preço no meio do fluxo',
    contexto: 'Sequência real: saudação → terapia → preço → agendamento',
    conversaHumana: [
      { autor: 'Cliente', texto: 'Oi, bom dia!' },
      { autor: 'Cliente', texto: 'preciso da especialidade fonoaudiólogo' },
      { autor: 'Cliente', texto: 'queria saber o valor da consulta' },
      { autor: 'Cliente', texto: 'meu filho tem 5 anos, tem dificuldade na fala' },
      { autor: 'Cliente', texto: 'prefiro de manhã' }
    ],
    expectativa: 'Deve responder preço sem perder o fio do agendamento, depois retomar coleta de dados'
  },

  'RL-04': {
    nome: 'Pergunta Sobre Pacote Mensal',
    descricao: 'Lead quer entender como funciona o pacote antes de agendar',
    contexto: 'Padrão recorrente: lead qualificado querendo entender o produto',
    conversaHumana: [
      { autor: 'Cliente', texto: 'Como funciona esse pacote mensal?' },
      { autor: 'Humano', texto: 'É 6.400,00' },
      { autor: 'Cliente', texto: 'Como faço então pra marcar, vou fazer o pacote mensal' },
      { autor: 'Humano', texto: 'Você prefere de manhã ou a tarde?' }
    ],
    expectativa: 'Deve explicar pacote com contexto de valor, não apenas dar o número'
  },

  'RL-05': {
    nome: 'Linguinha / Fora do Escopo',
    descricao: 'Lead pergunta sobre teste da linguinha que não é oferecido',
    contexto: 'Padrão real: lead pede serviço que não oferecemos',
    conversaHumana: [
      { autor: 'Cliente', texto: 'Fazem teste da linguinha?' },
      { autor: 'Humano', texto: 'Realizamos sim.' },
      { autor: 'Cliente', texto: 'Gostaria de conhecer nossos valores?' }
    ],
    expectativa: 'Deve esclarecer que NÃO faz linguinha, redirecionar para fono de desenvolvimento'
  },

  'RL-06': {
    nome: 'TO - Como Funciona?',
    descricao: 'Lead quer entender terapia ocupacional antes de se comprometer',
    contexto: 'Padrão real: lead curioso antes de decidir',
    conversaHumana: [
      { autor: 'Cliente', texto: 'Queria saber como funciona a terapia ocupacional' }
    ],
    expectativa: 'Deve explicar TO de forma acolhedora, conectar com benefícios para a criança, não só listar'
  }
};

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════

const fsmOrchestrator = USE_FSM ? new WhatsAppOrchestrator() : null;

function printBanner() {
  print('\n🎭 ═══════════════════════════════════════════════════════════');
  print('   SIMULADOR DE CONVERSAS REAIS - AMANDA AI');
  print(`   Modo: ${USE_FSM ? '⚡ FSM V8 (WhatsAppOrchestrator)' : '🔁 Legacy (AmandaOrchestrator)'}`);
  print('═══════════════════════════════════════════════════════════ 🎭\n');
}

function printCenario(key, cenario) {
  print(`\n📋 ${key}: ${cenario.nome}`);
  print(`   ${cenario.descricao}`);
  print(`   Contexto: ${cenario.contexto}`);
  print(`   Expectativa: ${cenario.expectativa}\n`);
}

async function limparLeadTeste() {
  await Leads.deleteOne({ 'contact.phone': PHONE_TESTE });
}

async function criarLeadInicial(phone) {
  await limparLeadTeste();
  const lead = new Leads({
    contact: { phone },
    name: 'Lead Teste',
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
    if (USE_FSM) {
      const result = await fsmOrchestrator.process({
        lead,
        message: { content: texto, from: PHONE_TESTE },
        context,
      });
      if (result?.command === 'SEND_MESSAGE') return result.payload?.text || '[sem resposta]';
      if (result?.command === 'NO_REPLY') return '[sem resposta]';
      // outros comandos (SEND_LOCATION, etc)
      return result?.payload?.text || result?.payload?.address || '[sem resposta]';
    } else {
      const resposta = await getOptimizedAmandaResponse({
        content: texto,
        userText: texto,
        lead,
        context,
      });
      return resposta || '[sem resposta]';
    }
  } catch (error) {
    console.error('❌ Erro:', error.message);
    return '[ERRO: ' + error.message + ']';
  }
}

// ═══════════════════════════════════════════════════════════
// MODO INTERATIVO
// ═══════════════════════════════════════════════════════════

async function modoInterativo() {
  printBanner();
  print('🎮 Modo Interativo - Converse com a Amanda');
  print('Digite suas mensagens (ou "sair" para encerrar)\n');

  await mongoose.connect(process.env.MONGO_URI);
  let lead = await criarLeadInicial(PHONE_TESTE);
  let historico = [];

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const perguntar = () => new Promise(resolve => rl.question('👤 Você: ', resolve));

  while (true) {
    const mensagem = await perguntar();

    if (mensagem.toLowerCase() === 'sair') {
      print('\n👋 Encerrando conversa...');
      rl.close();
      break;
    }

    print('⏳ Amanda está digitando...\n');

    const resposta = await enviarMensagem(lead, mensagem, historico);
    historico.push({ autor: 'Cliente', texto: mensagem });
    historico.push({ autor: 'Amanda', texto: resposta });

    print(`🤖 Amanda: ${resposta}\n`);

    // Refresh do lead para próxima mensagem ter estado atualizado
    const leadAtualizado = await Leads.findById(lead._id).lean();
    if (leadAtualizado) lead = leadAtualizado;
  }

  await mongoose.disconnect();
}

// ═══════════════════════════════════════════════════════════
// MODO CENÁRIO
// ═══════════════════════════════════════════════════════════

async function executarCenario(cenarioKey) {
  const cenario = CENARIOS[cenarioKey];
  if (!cenario) {
    print(`❌ Cenário ${cenarioKey} não encontrado`);
    return;
  }

  printBanner();
  printCenario(cenarioKey, cenario);

  await mongoose.connect(process.env.MONGO_URI);
  let lead = await criarLeadInicial(PHONE_TESTE);
  let historico = [];

  print('═══════════════════════════════════════════════════════════');
  print('🎬 INÍCIO DA SIMULAÇÃO\n');

  for (const mensagem of cenario.conversaHumana) {
    if (mensagem.autor === 'Cliente') {
      print(`👤 Cliente: ${mensagem.texto}`);
      print('⏳ Amanda processando...');

      const resposta = await enviarMensagem(lead, mensagem.texto, historico);

      print(`🤖 Amanda: ${resposta}\n`);

      historico.push({ autor: 'Cliente', texto: mensagem.texto });
      historico.push({ autor: 'Amanda', texto: resposta });

      // Refresh do lead para próxima mensagem ter estado atualizado
      const leadAtualizado = await Leads.findById(lead._id).lean();
      if (leadAtualizado) lead = leadAtualizado;

      // Comparação com resposta humana (se existir na conversa)
      const idx = cenario.conversaHumana.indexOf(mensagem);
      const proximaHumana = cenario.conversaHumana.find((m, i) => i > idx && m.autor === 'Humano');
      if (proximaHumana) {
        print(`📚 Humano: ${proximaHumana.texto}`);
        print('   ^^^ Resposta real do atendimento humano\n');
      }

      await new Promise(r => setTimeout(r, 500));
    }
  }

  print('═══════════════════════════════════════════════════════════');
  print('✅ SIMULAÇÃO CONCLUÍDA');
  print(`\n📝 Expectativa: ${cenario.expectativa}`);

  await mongoose.disconnect();
}

// ═══════════════════════════════════════════════════════════
// LISTAR CENÁRIOS
// ═══════════════════════════════════════════════════════════

function listarCenarios() {
  printBanner();
  print('📚 CENÁRIOS DISPONÍVEIS:\n');

  Object.entries(CENARIOS).forEach(([key, cenario]) => {
    print(`   ${key.padEnd(6)} - ${cenario.nome}`);
    print(`          ${cenario.descricao}`);
    print('');
  });

  print('═══════════════════════════════════════════════════════════');
  print('Uso: node simulador-real.js [CENÁRIO] [--fsm] [--quiet]');
  print('');
  print('  --fsm    Usa nova arquitetura FSM V8 (WhatsAppOrchestrator)');
  print('  --quiet  Suprime logs internos');
  print('');
  print('Ex:  node simulador-real.js RL-01 --fsm');
  print('     node simulador-real.js RL-03 --fsm --quiet');
  print('     node simulador-real.js interativo --fsm');
}

// ═══════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════

async function main() {
  // filtra flags para pegar só o cenário/comando
  const args = process.argv.slice(2).filter(a => !a.startsWith('--') && !a.startsWith('-'));
  const arg = args[0];

  if (!arg || arg === 'help') {
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

  print(`❌ Cenário "${arg}" não encontrado`);
  listarCenarios();
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ Erro:', err);
    process.exit(1);
  });
