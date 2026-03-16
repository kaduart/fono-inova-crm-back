/**
 * Meta Ads API - Script de Autorização OAuth
 * App: Ads API - Fono Inova (Empresa)
 */

const APP_ID = '26523881530539608';
const REDIRECT_URI = 'https://developers.facebook.com/tools/explorer/callback';

// Permissões de Marketing API
const SCOPES = [
  'ads_read',
  'ads_management',
  'business_management',
  'pages_read_engagement'
].join(',');

console.log('🚀 Meta Ads API - Autorização\n');
console.log('='.repeat(70));
console.log('\n📱 Novo APP ID:', APP_ID);
console.log('✅ Tipo: Empresa (com Marketing API)');
console.log('\n📋 Permissões:');
console.log('   ✅ ads_read');
console.log('   ✅ ads_management');
console.log('   ✅ business_management');
console.log('   ✅ pages_read_engagement');

// URL de autorização
const authUrl = `https://www.facebook.com/v18.0/dialog/oauth?` +
  `client_id=${APP_ID}&` +
  `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
  `scope=${encodeURIComponent(SCOPES)}&` +
  `response_type=token`;

console.log('\n' + '='.repeat(70));
console.log('\n🔗 URL DE AUTORIZAÇÃO:');
console.log('\n' + authUrl);
console.log('\n' + '='.repeat(70));
console.log('\n✅ INSTRUÇÕES:');
console.log('1. Copie a URL acima e cole no navegador');
console.log('2. Autorize o aplicativo quando o Facebook pedir');
console.log('3. Você será redirecionado para o Graph API Explorer');
console.log('4. Copie o Access Token que aparecer na página');
console.log('5. Me envie o token para testarmos!');
console.log('\n' + '='.repeat(70));
