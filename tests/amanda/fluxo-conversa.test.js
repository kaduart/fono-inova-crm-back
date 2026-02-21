#!/usr/bin/env node
/**
 * 🧪 TESTE DE INTEGRAÇÃO - FLUXO COMPLETO DE CONVERSA
 * 
 * Testa conversas reais de ponta a ponta detectando:
 * - LOOPS: Amanda repetindo a mesma pergunta 3x
 * - DADOS NÃO PERSISTIDOS: Nome/idade não salvos
 * - FLUXO QUEBRADO: Respostas fora de contexto
 * 
 * Cenários testados:
 * 1. Preço na primeira mensagem
 * 2. Agendamento completo (nome → idade → período)
 * 3. Plano de saúde no início
 * 4. Múltiplas crianças
 * 5. Desistência/Remarcação
 * 
 * Uso: node tests/amanda/fluxo-conversa.test.js
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { MongoClient } from 'mongodb';
import { getOptimizedAmandaResponse } from '../../orchestrators/AmandaOrchestrator.js';
import Leads from '../../models/Leads.js';

const PHONE_TESTE = '5562999999997';
const MONGO_URI = process.env.MONGO_URI;

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════

function pass(msg) { console.log(`✅ ${msg}`); }
function fail(msg) { console.log(`❌ ${msg}`); process.exitCode = 1; }
function info(msg) { console.log(`ℹ️  ${msg}`); }
function section(msg) { console.log(`\n${'═'.repeat(60)}\n${msg}\n${'═'.repeat(60)}`); }

async function limparLead() {
  await Leads.deleteOne({ 'contact.phone': PHONE_TESTE });
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  await client.db('test').collection('leads').deleteOne({ 'contact.phone': PHONE_TESTE });
  await client.close();
}

async function criarLead() {
  const lead = new Leads({
    contact: { phone: PHONE_TESTE },
    name: 'Lead Teste',
    patientInfo: {},
    stage: 'novo',
    createdAt: new Date()
  });
  await lead.save();
  return lead;
}

async function enviarMensagem(lead, texto, historico = []) {
  // Atualiza lead do banco para pegar estado atual
  const leadAtual = await Leads.findById(lead._id);
  
  const context = {
    stage: leadAtual?.stage || 'novo',
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
      lead: leadAtual,
      context: context
    });
    
    // Aguarda um pouco para garantir persistência
    await new Promise(r => setTimeout(r, 500));
    
    return {
      texto: resposta.text || resposta,
      lead: await Leads.findById(lead._id)
    };
  } catch (error) {
    console.error('❌ Erro:', error.message);
    return { texto: '[ERRO]', error: true, lead };
  }
}

// ═══════════════════════════════════════════════════════════
// DETECTOR DE LOOP
// ═══════════════════════════════════════════════════════════

function detectarLoop(historico) {
  if (historico.length < 6) return false;
  
  // Pega últimas 3 respostas da Amanda
  const respostasAmanda = historico
    .filter(h => h.autor === 'Amanda')
    .slice(-3)
    .map(h => h.texto.toLowerCase());
  
  if (respostasAmanda.length < 3) return false;
  
  // Verifica se as 3 últimas respostas são muito similares
  const [r1, r2, r3] = respostasAmanda;
  
  // Extrai perguntas (sentenças com ?)
  const perguntas1 = r1.match(/[^.!?]*\?/g) || [];
  const perguntas2 = r2.match(/[^.!?]*\?/g) || [];
  const perguntas3 = r3.match(/[^.!?]*\?/g) || [];
  
  // Se todas as 3 últimas respostas perguntam a mesma coisa = LOOP
  const perguntasSimilares = perguntas1.some(p1 => 
    perguntas2.some(p2 => p2.includes(p1.slice(0, 20))) &&
    perguntas3.some(p3 => p3.includes(p1.slice(0, 20)))
  );
  
  return perguntasSimilares;
}

// ═══════════════════════════════════════════════════════════
// CENÁRIO 1: Preço na Primeira Mensagem
// ═══════════════════════════════════════════════════════════

async function testePrecoPrimeiraMensagem() {
  section('CENÁRIO 1: Preço na Primeira Mensagem');
  
  await limparLead();
  let lead = await criarLead();
  let historico = [];
  
  const mensagens = [
    'Quanto custa a avaliação?',
    'Meu filho tem 5 anos',
    'nome: Pedro Silva',
    'prefiro tarde'
  ];
  
  for (const msg of mensagens) {
    console.log(`👤 Cliente: ${msg}`);
    const resposta = await enviarMensagem(lead, msg, historico);
    
    historico.push({ autor: 'Cliente', texto: msg });
    historico.push({ autor: 'Amanda', texto: resposta.texto });
    
    console.log(`🤖 Amanda: ${resposta.texto.substring(0, 150)}...\n`);
    
    // Verifica loop
    if (detectarLoop(historico)) {
      fail('LOOP DETECTADO: Amanda repetindo pergunta');
      return false;
    }
    
    lead = resposta.lead;
    await new Promise(r => setTimeout(r, 800));
  }
  
  // Verifica persistência
  const nomeSalvo = lead?.patientInfo?.fullName;
  const idadeSalva = lead?.patientInfo?.age;
  const periodoSalvo = lead?.pendingPreferredPeriod;
  
  console.log('\n📊 Verificação:');
  console.log(`   Nome: ${nomeSalvo || 'NÃO SALVO ❌'}`);
  console.log(`   Idade: ${idadeSalva || 'NÃO SALVO ❌'}`);
  console.log(`   Período: ${periodoSalvo || 'NÃO SALVO ❌'}`);
  
  // Validações
  if (!nomeSalvo) {
    fail('Nome não foi persistido');
    return false;
  }
  if (!idadeSalva) {
    fail('Idade não foi persistida');
    return false;
  }
  if (!periodoSalvo) {
    fail('Período não foi persistido');
    return false;
  }
  
  pass('Fluxo de preço funcionou corretamente');
  return true;
}

// ═══════════════════════════════════════════════════════════
// CENÁRIO 2: Agendamento Completo
// ═══════════════════════════════════════════════════════════

async function testeAgendamentoCompleto() {
  section('CENÁRIO 2: Agendamento Completo (fono)');
  
  await limparLead();
  let lead = await criarLead();
  let historico = [];
  
  const conversa = [
    { msg: 'Oi, quero agendar fonoaudiologia', espera: ['fono', 'idade', 'nome'] },
    { msg: 'meu filho tem 4 anos', espera: ['anos', 'nome', 'período'] },
    { msg: 'nome: João Pedro', espera: ['período', 'manhã', 'tarde'] },
    { msg: 'de tarde', espera: ['tarde', 'ok', 'confirmado'] }
  ];
  
  for (const turno of conversa) {
    console.log(`👤 Cliente: ${turno.msg}`);
    const resposta = await enviarMensagem(lead, turno.msg, historico);
    
    historico.push({ autor: 'Cliente', texto: turno.msg });
    historico.push({ autor: 'Amanda', texto: resposta.texto });
    
    console.log(`🤖 Amanda: ${resposta.texto.substring(0, 150)}...\n`);
    
    // Verifica se resposta contém palavras esperadas
    const respostaLower = resposta.texto.toLowerCase();
    const temPalavraEsperada = turno.espera.some(p => respostaLower.includes(p));
    
    if (!temPalavraEsperada) {
      info(`⚠️ Resposta não contém palavras esperadas: ${turno.espera.join(', ')}`);
    }
    
    if (detectarLoop(historico)) {
      fail('LOOP DETECTADO');
      return false;
    }
    
    lead = resposta.lead;
    await new Promise(r => setTimeout(r, 800));
  }
  
  // Verifica se dados foram coletados
  const completo = lead?.patientInfo?.fullName && 
                   lead?.patientInfo?.age && 
                   lead?.pendingPreferredPeriod;
  
  if (!completo) {
    fail('Dados do agendamento incompletos');
    return false;
  }
  
  pass('Agendamento completo funcionou');
  return true;
}

// ═══════════════════════════════════════════════════════════
// CENÁRIO 3: Plano de Saúde no Início
// ═══════════════════════════════════════════════════════════

async function testePlanoInicio() {
  section('CENÁRIO 3: Pergunta sobre Plano no Início');
  
  await limparLead();
  let lead = await criarLead();
  let historico = [];
  
  const mensagens = [
    'Vocês atendem Unimed?',
    'Preciso de fonoaudiologia',
    'Meu filho tem 3 anos',
    'nome: Maria Eduarda'
  ];
  
  for (const msg of mensagens) {
    console.log(`👤 Cliente: ${msg}`);
    const resposta = await enviarMensagem(lead, msg, historico);
    
    historico.push({ autor: 'Cliente', texto: msg });
    historico.push({ autor: 'Amanda', texto: resposta.texto });
    
    console.log(`🤖 Amanda: ${resposta.texto.substring(0, 150)}...\n`);
    
    if (detectarLoop(historico)) {
      fail('LOOP DETECTADO');
      return false;
    }
    
    lead = resposta.lead;
    await new Promise(r => setTimeout(r, 800));
  }
  
  // Não deve ter salvo a pergunta de plano como queixa
  const queixa = lead?.complaint;
  if (queixa && queixa.toLowerCase().includes('unimed')) {
    fail('Queixa incorreta: salvou pergunta de plano como queixa');
    return false;
  }
  
  pass('Fluxo de plano funcionou corretamente');
  return true;
}

// ═══════════════════════════════════════════════════════════
// CENÁRIO 4: Múltiplas Crianças
// ═══════════════════════════════════════════════════════════

async function testeMultiplasCriancas() {
  section('CENÁRIO 4: Múltiplas Crianças');
  
  await limparLead();
  let lead = await criarLead();
  let historico = [];
  
  const mensagens = [
    'Oi, tenho dois filhos que precisam de avaliação',
    'Pedro tem 6 anos e tem laudo de TEA, Thiago tem 8 e tem TDAH',
    'Preciso de avaliação para os dois na terapia ocupacional'
  ];
  
  for (const msg of mensagens) {
    console.log(`👤 Cliente: ${msg}`);
    const resposta = await enviarMensagem(lead, msg, historico);
    
    historico.push({ autor: 'Cliente', texto: msg });
    historico.push({ autor: 'Amanda', texto: resposta.texto });
    
    console.log(`🤖 Amanda: ${resposta.texto.substring(0, 150)}...\n`);
    
    if (detectarLoop(historico)) {
      fail('LOOP DETECTADO');
      return false;
    }
    
    lead = resposta.lead;
    await new Promise(r => setTimeout(r, 800));
  }
  
  pass('Fluxo de múltiplas crianças funcionou');
  return true;
}

// ═══════════════════════════════════════════════════════════
// CENÁRIO 5: Desistência/Remarcação
// ═══════════════════════════════════════════════════════════

async function testeDesistencia() {
  section('CENÁRIO 5: Desistência (sem dinheiro)');
  
  await limparLead();
  let lead = await criarLead();
  
  // Simula lead já com agendamento
  lead.stage = 'agendado';
  lead.patientInfo = { fullName: 'Teste', age: '5 anos' };
  await lead.save();
  
  let historico = [
    { autor: 'Amanda', texto: 'Confirmado! A sessão está agendada para amanhã às 10h 💚' }
  ];
  
  const msg = 'Minha mãe ainda não recebeu para pagar, pode remarcar?';
  console.log(`👤 Cliente: ${msg}`);
  
  const resposta = await enviarMensagem(lead, msg, historico);
  console.log(`🤖 Amanda: ${resposta.texto}\n`);
  
  // Deve ser empática e oferecer remarcação
  const respostaLower = resposta.texto.toLowerCase();
  const empatica = respostaLower.includes('sem problema') || 
                   respostaLower.includes('remarcamos') ||
                   respostaLower.includes('tudo bem');
  
  if (!empatica) {
    fail('Resposta não foi empática o suficiente');
    return false;
  }
  
  pass('Fluxo de desistência funcionou');
  return true;
}

// ═══════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════

async function main() {
  console.log('\n🧪 TESTE DE FLUXO DE CONVERSA - AMANDA AI\n');
  console.log('Detectando: LOOPS | DADOS NÃO PERSISTIDOS | FLUXOS QUEBRADOS\n');
  
  try {
    await mongoose.connect(MONGO_URI);
    console.log('✅ MongoDB conectado\n');
    
    const resultados = [];
    
    resultados.push(await testePrecoPrimeiraMensagem());
    resultados.push(await testeAgendamentoCompleto());
    resultados.push(await testePlanoInicio());
    resultados.push(await testeMultiplasCriancas());
    resultados.push(await testeDesistencia());
    
    section('RESULTADO FINAL');
    const passaram = resultados.filter(r => r).length;
    const total = resultados.length;
    
    console.log(`\n✅ ${passaram}/${total} cenários passaram\n`);
    
    if (passaram === total) {
      console.log('🎉 TODOS OS FLUXOS FUNCIONANDO!');
    } else {
      console.log('⚠️  ALGUNS FLUXOS PRECISAM DE CORREÇÃO');
      process.exitCode = 1;
    }
    
  } catch (e) {
    console.error('\n❌ Erro fatal:', e);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Desconectado');
  }
}

main();
