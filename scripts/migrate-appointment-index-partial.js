/**
 * 🔧 MIGRAÇÃO: Recriar índice único de appointments com partialFilterExpression
 * 
 * Problema: O índice `unique_appointment_slot` pode ter sido criado ANTES
 * do partialFilterExpression, bloqueando TODOS os status (incluindo canceled).
 * 
 * Essa migration:
 * 1. Dropa o índice antigo (se existir)
 * 2. Verifica duplicidades em slots ativos
 * 3. Recria o índice com partialFilterExpression correto
 * 
 * Uso:
 *   export MONGO_URI="..."
 *   cd /home/user/projetos/crm/back && node ../scripts/migrate-appointment-index-partial.js
 */

import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('❌ Defina MONGO_URI');
  process.exit(1);
}

const NON_BLOCKING = ['canceled', 'cancelado', 'cancelada', 'completed'];

async function run() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const collection = db.collection('appointments');

  console.log('══════════════════════════════════════════');
  console.log('  MIGRAÇÃO: Índice Parcial de Appointments');
  console.log('══════════════════════════════════════════\n');

  // 1. LISTAR ÍNDICES ATUAIS
  console.log('1️⃣ Índices atuais da collection appointments:');
  const indexes = await collection.indexes();
  const targetIndex = indexes.find(idx => idx.name === 'unique_appointment_slot');
  
  if (!targetIndex) {
    console.log('   ℹ️  Índice "unique_appointment_slot" NÃO existe. Vou criar.');
  } else {
    console.log('   📋 Índice encontrado:');
    console.log('      key:', JSON.stringify(targetIndex.key));
    console.log('      unique:', targetIndex.unique);
    console.log('      partialFilterExpression:', JSON.stringify(targetIndex.partialFilterExpression || null));
    
    if (targetIndex.partialFilterExpression) {
      console.log('   ✅ Índice JÁ tem partialFilterExpression. Nenhuma ação necessária.');
      await mongoose.disconnect();
      return;
    }
    
    console.log('   ⚠️  Índice existe mas NÃO tem partialFilterExpression!');
    console.log('   🗑️  Dropando índice antigo...');
    await collection.dropIndex('unique_appointment_slot');
    console.log('   ✅ Índice antigo removido.');
  }

  // 2. VERIFICAR DUPLICIDADES ANTES DE RECRIAR
  console.log('\n2️⃣ Verificando duplicidades em slots ativos...');
  const duplicates = await collection.aggregate([
    {
      $match: {
        operationalStatus: { $nin: NON_BLOCKING },
        doctor: { $exists: true, $ne: null }
      }
    },
    {
      $group: {
        _id: { doctor: "$doctor", date: "$date", time: "$time" },
        count: { $sum: 1 },
        docs: { $push: { _id: "$_id", status: "$operationalStatus", patient: "$patient" } }
      }
    },
    { $match: { count: { $gt: 1 } } }
  ]).toArray();

  if (duplicates.length > 0) {
    console.log(`   🚨 ENCONTRADAS ${duplicates.length} duplicidades!`);
    duplicates.forEach((dup, i) => {
      console.log(`   ${i+1}. Doctor: ${dup._id.doctor} | ${dup._id.date} ${dup._id.time}`);
      dup.docs.forEach(d => console.log(`      - ${d._id} [${d.status}] patient:${d.patient}`));
    });
    console.log('\n   ❌ NÃO é seguro criar o índice único agora.');
    console.log('   Ação necessária: Resolva as duplicidades manualmente antes.');
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log('   ✅ Nenhuma duplicidade encontrada. Seguro criar índice.');

  // 3. CRIAR ÍNDICE PARCIAL CORRETO
  console.log('\n3️⃣ Criando índice parcial...');
  await collection.createIndex(
    { doctor: 1, date: 1, time: 1 },
    {
      unique: true,
      name: 'unique_appointment_slot',
      partialFilterExpression: {
        operationalStatus: { $nin: NON_BLOCKING },
        doctor: { $exists: true, $ne: null }
      }
    }
  );
  console.log('   ✅ Índice "unique_appointment_slot" criado com partialFilterExpression!');

  // 4. VALIDAR
  console.log('\n4️⃣ Validando...');
  const newIndexes = await collection.indexes();
  const newIndex = newIndexes.find(idx => idx.name === 'unique_appointment_slot');
  console.log('   Novo índice:');
  console.log('      key:', JSON.stringify(newIndex.key));
  console.log('      unique:', newIndex.unique);
  console.log('      partialFilterExpression:', JSON.stringify(newIndex.partialFilterExpression));

  console.log('\n══════════════════════════════════════════');
  console.log('  ✅ MIGRAÇÃO CONCLUÍDA');
  console.log('══════════════════════════════════════════');
  console.log('\nAgora você pode:');
  console.log('   - Cancelar appointments sem bloquear o slot');
  console.log('   - Reagendar no mesmo horário após cancelamento');
  console.log('   - pre_agendado continua bloqueando (evita duplicata real)');

  await mongoose.disconnect();
}

run().catch(err => {
  console.error('❌ Erro:', err);
  process.exit(1);
});
