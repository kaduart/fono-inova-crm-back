#!/usr/bin/env node
/**
 * Script para trocar token curto do Meta por token longo (60 dias)
 * Uso: node scripts/refresh-meta-token.js <TOKEN_CURTO> [APP_ID] [APP_SECRET]
 */

import dotenv from 'dotenv';
dotenv.config();

const SHORT_TOKEN = process.argv[2] || process.env.META_ACCESS_TOKEN;
const APP_ID = process.argv[3] || process.env.META_APP_ID || '26523881530539608';
const APP_SECRET = process.argv[4] || process.env.META_APP_SECRET;

if (!SHORT_TOKEN) {
  console.error('❌ Erro: Token não fornecido');
  console.log('Uso: node scripts/refresh-meta-token.js <TOKEN_CURTO> [APP_ID] [APP_SECRET]');
  console.log('Ou defina META_ACCESS_TOKEN no .env');
  process.exit(1);
}

if (!APP_SECRET) {
  console.error('❌ Erro: APP_SECRET não fornecido');
  console.log('Pegue o App Secret em: https://developers.facebook.com/apps/' + APP_ID + '/settings/basic/');
  console.log('Uso: node scripts/refresh-meta-token.js <TOKEN_CURTO> ' + APP_ID + ' <APP_SECRET>');
  process.exit(1);
}

console.log('🔑 Trocando token curto por token longo...');
console.log('📱 App ID:', APP_ID);
console.log('🔒 Token curto:', SHORT_TOKEN.substring(0, 20) + '...');

async function exchangeToken() {
  try {
    const url = new URL('https://graph.facebook.com/v18.0/oauth/access_token');
    url.searchParams.append('grant_type', 'fb_exchange_token');
    url.searchParams.append('client_id', APP_ID);
    url.searchParams.append('client_secret', APP_SECRET);
    url.searchParams.append('fb_exchange_token', SHORT_TOKEN);

    const response = await fetch(url.toString());
    const data = await response.json();

    if (data.error) {
      console.error('❌ Erro na troca:', data.error.message);
      console.error('Código:', data.error.code);
      console.error('Tipo:', data.error.type);
      process.exit(1);
    }

    if (data.access_token) {
      const expiresInDays = Math.floor(data.expires_in / 86400);
      const expiryDate = new Date(Date.now() + data.expires_in * 1000);

      console.log('\n✅ Token longo gerado com sucesso!');
      console.log('\n📋 Token (copie este):');
      console.log('='.repeat(80));
      console.log(data.access_token);
      console.log('='.repeat(80));
      console.log('\n⏰ Expira em:', expiresInDays, 'dias');
      console.log('📅 Data de expiração:', expiryDate.toLocaleString('pt-BR'));
      console.log('\n📝 Atualize seu .env:');
      console.log('META_ACCESS_TOKEN=' + data.access_token);
      
      // Salvar automaticamente no .env se confirmar
      console.log('\n💡 Para atualizar automaticamente, execute:');
      console.log('echo "META_ACCESS_TOKEN=' + data.access_token + '" >> .env');
    }

  } catch (error) {
    console.error('❌ Erro:', error.message);
    process.exit(1);
  }
}

exchangeToken();
