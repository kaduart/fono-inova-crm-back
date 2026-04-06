/**
 * Verifica se o webhook está configurado corretamente
 */

import dotenv from 'dotenv';
dotenv.config();

console.log('═══════════════════════════════════════════════════');
console.log('🔍 VERIFICAÇÃO DO WEBHOOK');
console.log('═══════════════════════════════════════════════════\n');

const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;

console.log('Variáveis de ambiente:');
console.log('  WHATSAPP_VERIFY_TOKEN:', verifyToken ? `"${verifyToken}"` : '❌ NÃO CONFIGURADO');
console.log('  WHATSAPP_VERIFY_TOKEN (trim):', verifyToken ? `"${verifyToken.trim()}"` : '❌ NÃO CONFIGURADO');
console.log('  Comprimento:', verifyToken?.length || 0);

if (verifyToken) {
  console.log('\n✅ Token está configurado!');
  console.log('\nTeste de verificação:');
  console.log('  Mode: subscribe');
  console.log('  Token recebido: "fono-inova-verify-2025"');
  console.log('  Match:', verifyToken.trim() === 'fono-inova-verify-2025' ? '✅ SIM' : '❌ NÃO');
} else {
  console.log('\n❌ Token NÃO está configurado!');
  console.log('   Verifique as variáveis de ambiente no Render.');
}

console.log('\n═══════════════════════════════════════════════════');
