/**
 * Teste de conexão com Meta Ads API
 * Testa diferentes tokens e abordagens
 */

const ACCESS_TOKEN = process.argv[2] || 'SEU_TOKEN_AQUI';

async function testMetaAds() {
  console.log('🔍 Testando conexão com Meta Ads API...\n');

  // Test 1: Verificar usuário
  console.log('1️⃣ Verificando usuário...');
  try {
    const meResponse = await fetch(`https://graph.facebook.com/v18.0/me?access_token=${ACCESS_TOKEN}`);
    const me = await meResponse.json();
    console.log('✅ Usuário:', me.name, '(ID:', me.id + ')');
  } catch (e) {
    console.log('❌ Erro ao verificar usuário:', e.message);
  }

  // Test 2: Verificar permissões
  console.log('\n2️⃣ Verificando permissões...');
  try {
    const permResponse = await fetch(`https://graph.facebook.com/v18.0/me/permissions?access_token=${ACCESS_TOKEN}`);
    const perms = await permResponse.json();
    console.log('Permissões:', perms.data?.map(p => p.permission).join(', ') || 'Nenhuma');
    
    const hasAdsRead = perms.data?.some(p => p.permission === 'ads_read');
    const hasAdsManagement = perms.data?.some(p => p.permission === 'ads_management');
    
    if (hasAdsRead) console.log('✅ ads_read: OK');
    else console.log('❌ ads_read: NÃO TEM');
    
    if (hasAdsManagement) console.log('✅ ads_management: OK');
    else console.log('❌ ads_management: NÃO TEM');
  } catch (e) {
    console.log('❌ Erro ao verificar permissões:', e.message);
  }

  // Test 3: Tentar acessar contas de anúncios
  console.log('\n3️⃣ Tentando acessar contas de anúncios...');
  try {
    const accountsResponse = await fetch(`https://graph.facebook.com/v18.0/me/adaccounts?access_token=${ACCESS_TOKEN}`);
    const accounts = await accountsResponse.json();
    
    if (accounts.data && accounts.data.length > 0) {
      console.log('✅ Contas de anúncios encontradas:', accounts.data.length);
      accounts.data.forEach(acc => {
        console.log(`   - ${acc.name} (ID: ${acc.id})`);
      });
    } else if (accounts.error) {
      console.log('❌ Erro:', accounts.error.message);
    } else {
      console.log('⚠️ Nenhuma conta de anúncios encontrada');
    }
  } catch (e) {
    console.log('❌ Erro ao acessar contas:', e.message);
  }

  // Test 4: Tentar acessar via Business Manager
  console.log('\n4️⃣ Tentando acessar via Business Manager...');
  const businessId = '2569830913354809';
  try {
    const bmResponse = await fetch(`https://graph.facebook.com/v18.0/${businessId}/owned_ad_accounts?access_token=${ACCESS_TOKEN}`);
    const bmAccounts = await bmResponse.json();
    
    if (bmAccounts.data && bmAccounts.data.length > 0) {
      console.log('✅ Contas via BM encontradas:', bmAccounts.data.length);
      bmAccounts.data.forEach(acc => {
        console.log(`   - ${acc.name} (ID: ${acc.id})`);
      });
    } else if (bmAccounts.error) {
      console.log('❌ Erro:', bmAccounts.error.message);
    } else {
      console.log('⚠️ Nenhuma conta via BM encontrada');
    }
  } catch (e) {
    console.log('❌ Erro ao acessar via BM:', e.message);
  }

  console.log('\n✨ Teste concluído!');
}

// Executar teste
testMetaAds().catch(console.error);
