// ============================================================================
// 🧪 TESTE BÁSICO - PASSO A PASSO COM LOGS DETALHADOS
// ============================================================================
// Arquivo: scripts/amanda/teste-basico.js
// Execução: node scripts/amanda/teste-basico.js
// ============================================================================

console.log('🚀 Iniciando teste básico...\n');

// ============================================================================
// PASSO 1: Carrega .env
// ============================================================================
console.log('📋 PASSO 1: Carregando .env...');
try {
    await import('dotenv/config');
    console.log('✅ .env carregado\n');
} catch (error) {
    console.error('❌ Erro ao carregar .env:', error.message);
    process.exit(1);
}

// ============================================================================
// PASSO 2: Conecta MongoDB
// ============================================================================
console.log('📡 PASSO 2: Conectando ao MongoDB...');
let mongoose;
try {
    mongoose = (await import('mongoose')).default;
    console.log('✅ Mongoose importado');

    const mongoUri = process.env.MONGO_URI;
    console.log('🔌 URI:', mongoUri.substring(0, 30) + '...');

    await mongoose.connect(mongoUri, {
        serverSelectionTimeoutMS: 10000
    });
    console.log('✅ MongoDB conectado\n');

} catch (error) {
    console.error('❌ Erro de conexão:', error.message);
    process.exit(1);
}

// ============================================================================
// PASSO 3: Importa o Service
// ============================================================================
console.log('📦 PASSO 3: Importando amandaBookingService...');
let bookingService;
try {
    bookingService = await import('../../services/amandaBookingService.js');
    console.log('✅ Service importado');
    console.log('✅ Funções disponíveis:', Object.keys(bookingService).join(', '));
    console.log('');

} catch (error) {
    console.error('❌ Erro ao importar service:', error.message);
    console.error('Stack:', error.stack);
    await mongoose.disconnect();
    process.exit(1);
}

// ============================================================================
// PASSO 4: Verifica Models
// ============================================================================
console.log('🗄️  PASSO 4: Verificando models...');
try {
    const doctorCount = await mongoose.connection.db.collection('doctors').countDocuments();
    console.log(`✅ Total de doctors na collection: ${doctorCount}`);

    if (doctorCount > 0) {
        const sample = await mongoose.connection.db.collection('doctors').findOne();
        console.log(`✅ Exemplo de doctor:`, {
            name: sample.name,
            specialty: sample.specialty,
            isActive: sample.isActive
        });
    } else {
        console.log('⚠️  Nenhum médico cadastrado');
    }
    console.log('');

} catch (error) {
    console.error('⚠️  Erro ao verificar models:', error.message);
}

// ============================================================================
// PASSO 5: Testa Busca de Slots (REAL)
// ============================================================================
console.log('🔍 PASSO 5: Testando busca de slots...');
try {
    console.log('   Buscando slots de fonoaudiologia...');

    const slots = await bookingService.findAvailableSlots({
        therapyArea: 'fonoaudiologia',
        daysAhead: 7
    });

    if (!slots) {
        console.log('❌ Nenhum slot encontrado');
        console.log('   Possíveis causas:');
        console.log('   - Nenhum médico ativo de fonoaudiologia');
        console.log('   - Todos os horários ocupados');
        console.log('   - weeklyAvailability não configurado');
    } else {
        console.log('✅ Slots encontrados!');
        console.log('   Primary:', bookingService.formatSlot(slots.primary));
        console.log('   Total disponível:', slots.totalFound);
    }

} catch (error) {
    console.error('❌ Erro na busca:', error.message);
    console.error('Stack:', error.stack);
}

// ============================================================================
// FINALIZAÇÃO
// ============================================================================
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('✅ TESTE BÁSICO CONCLUÍDO');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

await mongoose.disconnect();
console.log('📡 MongoDB desconectado\n');

process.exit(0);