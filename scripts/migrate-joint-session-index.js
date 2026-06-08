/**
 * Migração: Recriar índice unique_appointment_slot para suportar Sessão Conjunta
 *
 * Mudanças:
 * - Usa $in com statuses bloqueantes (MongoDB não suporta $nin em partialFilterExpression)
 * - Adiciona isJointSession: false ao filtro (joint sessions ficam fora do constraint único)
 * - Backfill: seta isJointSession: false em todos os docs existentes antes de criar o índice
 *
 *   node scripts/migrate-joint-session-index.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error('❌ MONGODB_URI não encontrado no .env');
  process.exit(1);
}

// Todos os statuses que BLOQUEIAM o slot (inverso de NON_BLOCKING_OPERATIONAL_STATUSES)
const BLOCKING_STATUSES = [
  'pre_agendado', 'scheduled', 'confirmed', 'pending', 'paid',
  'missed', 'processing_create', 'processing_complete', 'processing_cancel', 'force_cancelled'
];

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('✅ Conectado ao MongoDB');

  const db = mongoose.connection.db;
  const collection = db.collection('appointments');

  // 1. Drop índice antigo se existir
  const indexes = await collection.indexes();
  const existing = indexes.find(i => i.name === 'unique_appointment_slot');

  if (existing) {
    console.log('🗑️  Dropando índice antigo:', JSON.stringify(existing.partialFilterExpression));
    await collection.dropIndex('unique_appointment_slot');
    console.log('✅ Índice antigo removido');
  } else {
    console.log('ℹ️  Índice unique_appointment_slot não encontrado — criando do zero');
  }

  // 2. Backfill: documentos sem isJointSession recebem false
  //    (necessário para que entrem no índice parcial com isJointSession: false)
  const backfillResult = await collection.updateMany(
    { isJointSession: { $exists: false } },
    { $set: { isJointSession: false } }
  );
  console.log(`✅ Backfill: ${backfillResult.modifiedCount} documentos receberam isJointSession: false`);

  // 3. Cria novo índice
  //    - $in com statuses bloqueantes (MongoDB não suporta $nin em partialFilterExpression)
  //    - isJointSession: false exclui sessões conjuntas do constraint único
  await collection.createIndex(
    { doctor: 1, date: 1, time: 1 },
    {
      unique: true,
      name: 'unique_appointment_slot',
      partialFilterExpression: {
        operationalStatus: { $in: BLOCKING_STATUSES },
        doctor: { $exists: true },
        isJointSession: false
      }
    }
  );

  console.log('✅ Novo índice criado — mesmo profissional pode ter Sessão Conjunta no mesmo horário');

  const allIndexes = await collection.indexes();
  const newIdx = allIndexes.find(i => i.name === 'unique_appointment_slot');
  console.log('📋 Definição:', JSON.stringify(newIdx?.partialFilterExpression, null, 2));

  await mongoose.disconnect();
  console.log('✅ Migração concluída');
}

run().catch(err => {
  console.error('💥 Erro na migração:', err.message);
  process.exit(1);
});
