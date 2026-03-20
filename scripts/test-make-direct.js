#!/usr/bin/env node
/**
 * 🧪 Teste direto do webhook Make
 * Verifica exatamente o que o Make retorna
 */

import dotenv from 'dotenv';
dotenv.config();

const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;

console.log('🧪 TESTE DIRETO DO MAKE\n');
console.log('URL:', MAKE_WEBHOOK_URL?.substring(0, 50) + '...');
console.log('');

const payload = {
  postId: 'test-' + Date.now(),
  title: 'Teste de conexão - Fono Inova',
  content: 'Este é um teste de diagnóstico. Ignore.',
  mediaUrl: null,
  ctaUrl: null,
  _test: true
};

async function testMake() {
  console.log('➡️  Enviando payload de teste...\n');
  
  try {
    const response = await fetch(MAKE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    console.log('Status HTTP:', response.status);
    console.log('Status Text:', response.statusText);
    console.log('');
    
    const text = await response.text();
    console.log('Resposta do Make:');
    console.log(text || '(vazio)');
    console.log('');
    
    // Headers de resposta
    console.log('Headers de resposta:');
    response.headers.forEach((value, name) => {
      console.log(`  ${name}: ${value}`);
    });
    
    if (response.status === 400 && text.includes('Queue')) {
      console.log('\n❌ CONFIRMADO: A fila do Make está cheia!');
      console.log('   Isso acontece quando:');
      console.log('   - Seu plano Make atingiu o limite de operações');
      console.log('   - O webhook específico está recebendo muitas chamadas');
      console.log('   - Tem um gargalo no cenário do Make');
    }
    
  } catch (error) {
    console.error('❌ Erro na requisição:', error.message);
  }
}

testMake();
