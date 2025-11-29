console.log('🔍 INICIANDO DIAGNÓSTICO DO SISTEMA...\n');

// ============================================================================
// TESTE 1: Variáveis de Ambiente
// ============================================================================
console.log('━'.repeat(70));
console.log('📋 TESTE 1: Variáveis de Ambiente');
console.log('━'.repeat(70));

try {
    await import('dotenv/config');
    console.log('✅ dotenv carregado');

    const checks = {
        'MONGODB_URI ou MONGO_URI': process.env.MONGODB_URI || process.env.MONGO_URI,
        'INTERNAL_BASE_URL': process.env.INTERNAL_BASE_URL,
        'ADMIN_API_TOKEN': process.env.ADMIN_API_TOKEN
    };

    let hasErrors = false;
    for (const [key, value] of Object.entries(checks)) {
        if (value) {
            console.log(`✅ ${key}: ${key.includes('TOKEN') ? '***' + value.slice(-4) : value}`);
        } else {
            console.log(`❌ ${key}: NÃO DEFINIDA`);
            hasErrors = true;
        }
    }

    if (hasErrors) {
        console.log('\n⚠️  AÇÃO: Adicione as variáveis faltantes no .env\n');
        process.exit(1);
    }

} catch (error) {
    console.log('❌ Erro ao carregar .env:', error.message);
    process.exit(1);
}
