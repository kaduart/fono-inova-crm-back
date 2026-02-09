/**
 * 🧹 LIMPEZA DE DADOS DE TESTE
 *
 * Remove todos os dados do número de teste para começar fresh
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

// ========================================
// CONFIGURAÇÃO
// ========================================

const TEST_PHONE = process.env.TEST_PHONE || "556181694922";

// ========================================
// CONEXÃO MONGODB
// ========================================

async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('✅ Conectado ao MongoDB');
  } catch (error) {
    console.error('❌ Erro ao conectar MongoDB:', error.message);
    process.exit(1);
  }
}

// ========================================
// LIMPEZA
// ========================================

async function cleanup() {
  console.log('\n🧹 LIMPANDO DADOS DE TESTE\n');
  console.log(`📱 Número: ${TEST_PHONE}\n`);

  const db = mongoose.connection.db;

  // 1. Contacts
  console.log('🗑️  Limpando Contacts...');
  const contactsResult = await db.collection('contacts').deleteMany({
    phone: TEST_PHONE
  });
  console.log(`   ✅ ${contactsResult.deletedCount} contatos deletados`);

  // 2. Leads
  console.log('🗑️  Limpando Leads...');
  const leadsResult = await db.collection('leads').deleteMany({
    'contact.phone': TEST_PHONE
  });
  console.log(`   ✅ ${leadsResult.deletedCount} leads deletados`);

  // 3. Messages
  console.log('🗑️  Limpando Messages...');
  const messagesResult = await db.collection('messages').deleteMany({
    $or: [
      { from: TEST_PHONE },
      { to: TEST_PHONE }
    ]
  });
  console.log(`   ✅ ${messagesResult.deletedCount} mensagens deletadas`);

  // 4. ChatContext (se existir)
  try {
    console.log('🗑️  Limpando ChatContext...');
    const contextResult = await db.collection('chatcontexts').deleteMany({
      lead: { $in: await db.collection('leads').distinct('_id', { 'contact.phone': TEST_PHONE }) }
    });
    console.log(`   ✅ ${contextResult.deletedCount} contextos deletados`);
  } catch (error) {
    console.log('   ⚠️  ChatContext não existe ou já foi limpo');
  }

  // 5. Followups (se existir)
  try {
    console.log('🗑️  Limpando Followups...');
    const followupResult = await db.collection('followups').deleteMany({
      lead: { $in: await db.collection('leads').distinct('_id', { 'contact.phone': TEST_PHONE }) }
    });
    console.log(`   ✅ ${followupResult.deletedCount} followups deletados`);
  } catch (error) {
    console.log('   ⚠️  Followups não existe ou já foi limpo');
  }

  console.log('\n✅ LIMPEZA CONCLUÍDA!\n');
  console.log('📊 Resumo:');
  console.log(`   - ${contactsResult.deletedCount} contatos`);
  console.log(`   - ${leadsResult.deletedCount} leads`);
  console.log(`   - ${messagesResult.deletedCount} mensagens\n`);
}

// ========================================
// MAIN
// ========================================

async function main() {
  await connectDB();
  await cleanup();
  await mongoose.connection.close();
  console.log('👋 Conexão fechada. Até logo!\n');
}

main().catch(console.error);
