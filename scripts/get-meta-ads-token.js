/**
 * Gerador de URL de autorização para Meta Ads API
 * Usa APP_ID e APP_SECRET do .env
 */

import { config } from 'dotenv';
import readline from 'readline';
import http from 'http';
import url from 'url';

config({ path: '../back/.env' });

const APP_ID = process.env.META_APP_ID || '1239662767865979';
const APP_SECRET = process.env.META_APP_SECRET;
const REDIRECT_URI = 'http://localhost:3000/auth/callback';

// Permissões necessárias para Meta Ads
const SCOPES = [
  'ads_read',
  'ads_management', 
  'business_management',
  'pages_read_engagement'
].join(',');

console.log('🚀 Gerador de Token Meta Ads API\n');
console.log('APP_ID:', APP_ID);
console.log('APP_SECRET:', APP_SECRET ? '✅ Configurado' : '❌ Não encontrado');
console.log('\n📋 Permissões solicitadas:');
console.log('  - ads_read (ler dados de anúncios)');
console.log('  - ads_management (gerenciar campanhas)');
console.log('  - business_management (acesso ao BM)');
console.log('  - pages_read_engagement (ler páginas)');

// URL de autorização OAuth
const authUrl = `https://www.facebook.com/v18.0/dialog/oauth?` +
  `client_id=${APP_ID}&` +
  `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
  `scope=${SCOPES}&` +
  `response_type=token`;

console.log('\n🔗 URL de Autorização:');
console.log(authUrl);
console.log('\n✅ Instruções:');
console.log('1. Copie a URL acima e cole no navegador');
console.log('2. Autorize o aplicativo');
console.log('3. Você será redirecionado para localhost:3000');
console.log('4. O token estará na URL (access_token=...)');
console.log('\n💡 Alternativa: se o redirect falhar, abra o console do navegador (F12)');
console.log('   e procure por "access_token" na aba Network/Rede');

// Inicia servidor local para capturar o token
console.log('\n🖥️  Iniciando servidor local para capturar token...');

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  
  if (parsedUrl.pathname === '/auth/callback') {
    // Captura token do hash da URL (lado do cliente)
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Meta Ads Auth</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
          .token { background: #f0f0f0; padding: 20px; border-radius: 8px; word-break: break-all; }
          .success { color: green; }
          .error { color: red; }
        </style>
      </head>
      <body>
        <h1>🎉 Autorização Meta Ads</h1>
        <div id="status">Capturando token...</div>
        <div id="token" class="token" style="margin-top: 20px; display: none;"></div>
        <script>
          // Pega token do hash da URL
          const hash = window.location.hash;
          const tokenMatch = hash.match(/access_token=([^&]+)/);
          
          if (tokenMatch) {
            const token = tokenMatch[1];
            document.getElementById('status').innerHTML = '<h2 class="success">✅ Token capturado!</h2><p>Copie o token abaixo:</p>';
            document.getElementById('token').style.display = 'block';
            document.getElementById('token').textContent = token;
            
            // Envia para o servidor
            fetch('/token?access_token=' + token);
          } else {
            document.getElementById('status').innerHTML = '<h2 class="error">❌ Token não encontrado</h2><p>Hash: ' + hash + '</p>';
          }
        </script>
      </body>
      </html>
    `);
  } else if (parsedUrl.pathname === '/token') {
    const token = parsedUrl.query.access_token;
    if (token) {
      console.log('\n🎉 TOKEN CAPTURADO!\n');
      console.log('Access Token:', token);
      console.log('\n💾 Salve este token no arquivo .env como:');
      console.log('META_ACCESS_TOKEN=' + token);
      
      res.writeHead(200);
      res.end('OK');
      
      // Fecha servidor após 2 segundos
      setTimeout(() => {
        console.log('\n✨ Servidor fechado. Token salvo!');
        server.close();
        process.exit(0);
      }, 2000);
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(3000, () => {
  console.log('Servidor rodando em http://localhost:3000');
  console.log('Aguardando callback de autorização...\n');
});

// Timeout de 5 minutos
setTimeout(() => {
  console.log('\n⏱️ Timeout: Servidor fechado após 5 minutos');
  server.close();
  process.exit(1);
}, 300000);
