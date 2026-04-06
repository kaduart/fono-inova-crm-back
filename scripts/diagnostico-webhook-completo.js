/**
 * Diagnóstico completo do webhook
 */

// Simula exatamente o que o Meta envia
const TEST_URL = "https://fono-inova-crm-back.onrender.com/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=fono-inova-verify-2025&hub.challenge=teste123";

console.log('🔍 Testando webhook...');
console.log('URL:', TEST_URL);
console.log('');

// Teste 1: Verificar se o endpoint responde
fetch(TEST_URL)
  .then(res => {
    console.log('Status:', res.status);
    console.log('StatusText:', res.statusText);
    return res.text();
  })
  .then(text => {
    console.log('Resposta:', text);
    if (text === 'teste123') {
      console.log('✅ SUCESSO! Webhook configurado corretamente.');
    } else {
      console.log('❌ FALHA! Esperado: teste123');
      console.log('   Recebido:', text);
    }
  })
  .catch(err => {
    console.error('❌ ERRO:', err.message);
  });
