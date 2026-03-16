/**
 * Teste rápido do token Meta
 * Verifica se o token está válido
 */

import dotenv from 'dotenv';
dotenv.config({ path: '../back/.env' });

const token = process.env.META_ACCESS_TOKEN;

console.log('🧪 Teste de Token Meta Ads\n');
console.log('='.repeat(60));

if (!token) {
  console.log('❌ ERRO: META_ACCESS_TOKEN não encontrado no .env');
  process.exit(1);
}

console.log(`✅ Token encontrado`);
console.log(`📏 Tamanho: ${token.length} caracteres`);
console.log(`🔑 Primeiros 30 chars: ${token.substring(0, 30)}...`);
console.log(`🔚 Últimos 10 chars: ...${token.substring(token.length - 10)}`);

// Testar chamada simples
console.log('\n🌐 Testando chamada à API...\n');

try {
  const response = await fetch(`https://graph.facebook.com/v18.0/me?access_token=${token}`);
  const data = await response.json();
  
  if (data.error) {
    console.log('❌ ERRO NA API:');
    console.log(`   Tipo: ${data.error.type}`);
    console.log(`   Código: ${data.error.code}`);
    console.log(`   Mensagem: ${data.error.message}`);
    
    if (data.error.code === 190 || data.error.code === 200) {
      console.log('\n⚠️  O token expirou ou é inválido!');
      console.log('   Ações necessárias:');
      console.log('   1. Acesse: https://developers.facebook.com/tools/explorer/');
      console.log('   2. Selecione o app "Ads API - Fono Inova"');
      console.log('   3. Clique em "Generate Access Token"');
      console.log('   4. Copie o novo token para o .env');
    }
  } else {
    console.log('✅ TOKEN VÁLIDO!');
    console.log(`   Usuário: ${data.name}`);
    console.log(`   ID: ${data.id}`);
    
    // Testar acesso a ad accounts
    console.log('\n📊 Testando acesso às contas de anúncios...');
    const accountsRes = await fetch(`https://graph.facebook.com/v18.0/me/adaccounts?access_token=${token}`);
    const accountsData = await accountsRes.json();
    
    if (accountsData.error) {
      console.log('⚠️  Não foi possível acessar contas de anúncios:');
      console.log(`   ${accountsData.error.message}`);
    } else if (accountsData.data && accountsData.data.length > 0) {
      console.log(`✅ ${accountsData.data.length} conta(s) de anúncios acessível(is):`);
      accountsData.data.forEach(acc => {
        console.log(`   - ${acc.name} (${acc.id})`);
      });
    } else {
      console.log('⚠️  Nenhuma conta de anúncios encontrada');
    }
  }
} catch (error) {
  console.log('❌ ERRO:', error.message);
}

console.log('\n' + '='.repeat(60));
