/**
 * 🔁 migrate-guide-number-unique-per-patient.js
 *
 * Migração 2026-08-07 — Unicidade do número da guia passa a ser POR PACIENTE.
 *
 * Antes:  índice `number_1` UNIQUE global → duas guias com o mesmo número eram
 *         rejeitadas mesmo pertencendo a pacientes diferentes. Isso é errado:
 *         convênios/locais diferentes podem emitir o mesmo número para pacientes
 *         distintos, e isso é normal.
 *
 * Depois: índice `idx_unique_guide_number_per_patient` UNIQUE em { patientId, number }
 *         + índice `number_1` NÃO único (mantido só para busca por número).
 *
 * O script é idempotente e aborta sem escrever nada se encontrar duplicatas
 * (patientId, number) que impediriam a criação do índice único.
 *
 * Uso:
 *   node scripts/migrate-guide-number-unique-per-patient.js --dry-run
 *   node scripts/migrate-guide-number-unique-per-patient.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
const DRY_RUN = process.argv.includes('--dry-run');

const COLLECTION = 'insuranceguides';
const OLD_INDEX = 'number_1';
const NEW_INDEX = 'idx_unique_guide_number_per_patient';

if (!MONGO_URI) {
  console.error('❌ MONGO_URI ou MONGODB_URI não configurado');
  process.exit(1);
}

async function main() {
  await mongoose.connect(MONGO_URI, { maxPoolSize: 5, serverSelectionTimeoutMS: 30000 });
  const coll = mongoose.connection.collection(COLLECTION);

  console.log(`\n📋 Coleção: ${COLLECTION}${DRY_RUN ? '  (DRY-RUN)' : ''}`);

  const before = await coll.indexes();
  before.forEach(i => console.log('   ', i.name, JSON.stringify(i.key), i.unique ? 'UNIQUE' : ''));

  // ── Pré-checagem: duplicatas (patientId, number) bloqueiam o índice único ──
  const dups = await coll.aggregate([
    { $group: { _id: { patientId: '$patientId', number: '$number' }, count: { $sum: 1 }, ids: { $push: '$_id' } } },
    { $match: { count: { $gt: 1 } } }
  ]).toArray();

  if (dups.length > 0) {
    console.error(`\n❌ ABORTADO: ${dups.length} par(es) (patientId, number) duplicado(s).`);
    dups.slice(0, 20).forEach(d =>
      console.error(`   patientId=${d._id.patientId} number=${d._id.number} → ${d.count}x [${d.ids.join(', ')}]`)
    );
    console.error('   Resolva as duplicatas pela UI antes de rodar a migração.');
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log('\n✅ Nenhuma duplicata (patientId, number).');

  // ── 1) Dropa o índice global único e recria não-único ──
  const oldIdx = before.find(i => i.name === OLD_INDEX);
  if (oldIdx?.unique) {
    console.log(`\n🔻 ${OLD_INDEX} é UNIQUE global — dropar e recriar não-único`);
    if (!DRY_RUN) {
      await coll.dropIndex(OLD_INDEX);
      await coll.createIndex({ number: 1 }, { name: OLD_INDEX });
      console.log(`   ✔ ${OLD_INDEX} recriado sem unique`);
    }
  } else if (oldIdx) {
    console.log(`\n➖ ${OLD_INDEX} já é não-único — nada a fazer`);
  } else {
    console.log(`\n➕ ${OLD_INDEX} não existe — criando não-único`);
    if (!DRY_RUN) await coll.createIndex({ number: 1 }, { name: OLD_INDEX });
  }

  // ── 2) Cria o índice único composto por paciente ──
  if (before.some(i => i.name === NEW_INDEX)) {
    console.log(`➖ ${NEW_INDEX} já existe — nada a fazer`);
  } else {
    console.log(`➕ Criando ${NEW_INDEX} UNIQUE { patientId: 1, number: 1 }`);
    if (!DRY_RUN) {
      await coll.createIndex({ patientId: 1, number: 1 }, { name: NEW_INDEX, unique: true });
      console.log(`   ✔ ${NEW_INDEX} criado`);
    }
  }

  if (!DRY_RUN) {
    console.log('\n📋 Índices finais:');
    (await coll.indexes()).forEach(i =>
      console.log('   ', i.name, JSON.stringify(i.key), i.unique ? 'UNIQUE' : '')
    );
  }

  await mongoose.disconnect();
  console.log(DRY_RUN ? '\n🔎 DRY-RUN concluído (nada escrito).' : '\n✅ Migração concluída.');
}

main().catch(err => { console.error('❌', err); process.exit(1); });
