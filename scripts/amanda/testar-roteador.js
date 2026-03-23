#!/usr/bin/env node
/**
 * 🧪 TESTE RÁPIDO DO ROTEADOR DE INTENÇÃO
 * 
 * Valida se o roteador está detectando corretamente antes de aplicar no AmandaOrchestrator
 */

import { routeIntent, detectIntent, hasContextHint } from '../../utils/intentRouter.js';

console.log(`
╔════════════════════════════════════════════════════════════════╗
║  🧪 TESTE DO ROTEADOR DE INTENÇÃO                              ║
╚════════════════════════════════════════════════════════════════╝
`);

const testCases = [
  // Scheduling (agendamento)
  { msg: 'Quero agendar uma avaliação', expected: 'scheduling' },
  { msg: 'Tem horário disponível?', expected: 'scheduling' },
  { msg: 'Quero marcar para minha filha', expected: 'scheduling' },
  
  // Urgency (urgência emocional)
  { msg: 'Meu filho não fala nenhuma palavra', expected: 'urgency' },
  { msg: 'Estou desesperada, ele não anda', expected: 'urgency' },
  { msg: 'Urgente, preciso de ajuda', expected: 'urgency' },
  
  // Price (preço)
  { msg: 'Qual o valor da consulta?', expected: 'price' },
  { msg: 'Quanto custa?', expected: 'price' },
  
  // FirstContact (primeiro contato)
  { msg: 'Oi, bom dia', expected: 'firstContact' },
  { msg: 'Olá, gostaria de informações', expected: 'firstContact' },
  
  // Com contexto (terapia implícita)
  { msg: 'Oi! Vi o site da Clínica Fono Inova', expected: 'firstContact', hint: 'fonoaudiologia' },
  { msg: 'Quero agendar para fisioterapia', expected: 'scheduling', hint: 'fisioterapia' },
];

let passed = 0;
let failed = 0;

console.log('📋 TESTANDO DETECÇÃO DE INTENÇÃO:\n');

for (const test of testCases) {
  const result = routeIntent(test.msg);
  const success = result.intent === test.expected;
  
  const icon = success ? '✅' : '❌';
  const status = success ? 'PASSOU' : 'FALHOU';
  
  console.log(`${icon} "${test.msg.substring(0, 40)}..."`);
  console.log(`   Esperado: ${test.expected} | Detectado: ${result.intent} | Confiança: ${result.confidence.toFixed(1)}`);
  
  if (test.hint) {
    const hintMatch = result.hasTherapyHint === test.hint;
    const hintIcon = hintMatch ? '✅' : '❌';
    console.log(`   ${hintIcon} Contexto: ${result.hasTherapyHint || 'nenhum'}`);
    if (!hintMatch) success = false;
  }
  
  console.log(`   Resposta gerada: "${result.response.substring(0, 60)}..."`);
  console.log('');
  
  if (success) {
    passed++;
  } else {
    failed++;
  }
}

console.log('═'.repeat(64));
console.log(`📊 RESULTADO: ${passed}/${testCases.length} passaram`);
console.log('═'.repeat(64));

// Teste de variações (anti-robô)
console.log('\n🎲 TESTE DE VARIAÇÕES (3 execuções da mesma mensagem):\n');

const msg = 'Quero agendar';
const responses = new Set();

for (let i = 0; i < 3; i++) {
  const result = routeIntent(msg);
  responses.add(result.response);
  console.log(`Execução ${i + 1}: "${result.response.substring(0, 50)}..."`);
}

console.log(`\n${responses.size === 3 ? '✅' : '⚠️'}  ${responses.size} variações diferentes geradas`);

if (failed === 0) {
  console.log('\n🟢 TUDO CERTO! Pode aplicar o patch no AmandaOrchestrator.js');
} else {
  console.log('\n🟡 Alguns testes falharam. Revise os padrões em intentRouter.js');
}

console.log('\n💡 Próximo passo:');
console.log('   1. Aplique o patch no AmandaOrchestrator.js');
console.log('   2. Rode: node scripts/amanda/testar-roteador.js');
console.log('   3. Teste com replay real\n');
