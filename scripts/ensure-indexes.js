/**
 * 🛠️ ensure-indexes.js
 *
 * Cria fisicamente no MongoDB Atlas todos os índices declarados nos schemas.
 * Deve ser executado manualmente após deploys que adicionam/alteram índices,
 * pois o servidor roda com autoIndex=false em produção para evitar latência
 * causada por createIndex() em background a cada cold start.
 *
 * Quando um índice declarado conflita com um existente (mesmo nome, opções
 * diferentes), o script dropa o antigo e recria o novo — desde que não seja
 * um índice único com dados duplicados.
 *
 * Uso:
 *   NODE_ENV=production node scripts/ensure-indexes.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import '../models/index.js';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

if (!MONGO_URI) {
  console.error('❌ MONGO_URI ou MONGODB_URI não configurado');
  process.exit(1);
}

function indexName(spec, options) {
  if (options?.name) return options.name;
  return Object.keys(spec).map(k => `${k}_1`).join('_');
}

function needsRecreation(spec, options, existing) {
  const sameName = indexName(spec, options) === existing.name;
  if (!sameName) return false;

  const opts = options || {};
  const uniqueDiff = !!opts.unique !== !!existing.unique;
  const sparseDiff = !!opts.sparse !== !!existing.sparse;
  const ttlDiff = (opts.expireAfterSeconds || null) !== (existing.expireAfterSeconds || null);
  const partialDiff = JSON.stringify(opts.partialFilterExpression || null) !==
                      JSON.stringify(existing.partialFilterExpression || null);

  return uniqueDiff || sparseDiff || ttlDiff || partialDiff;
}

async function reconcileConflicts(Model, collection) {
  const declaredIndexes = Model.schema.indexes();
  const existingIndexes = await collection.indexes();
  const recreated = [];

  for (const [spec, options] of declaredIndexes) {
    const existing = existingIndexes.find(idx => indexName(spec, options) === idx.name);
    if (!existing) continue;

    if (needsRecreation(spec, options, existing)) {
      await collection.dropIndex(existing.name);
      await collection.createIndex(spec, { ...options, background: true });
      recreated.push(existing.name);
    }
  }

  return recreated;
}

async function ensureIndexes() {
  await mongoose.connect(MONGO_URI, {
    readPreference: 'primary',
    retryWrites: true,
    w: 'majority',
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 120000,
  });

  console.log('✅ MongoDB conectado');

  const models = Object.values(mongoose.models);
  const results = [];

  for (const Model of models) {
    try {
      const collection = Model.collection;
      const recreated = await reconcileConflicts(Model, collection);
      await Model.createIndexes();
      results.push({ model: Model.modelName, status: 'OK', recreated: recreated.join(', ') || '-' });
      console.log(`  ✅ ${Model.modelName}: índices garantidos${recreated.length ? ` (recriados: ${recreated.join(', ')})` : ''}`);
    } catch (err) {
      const isConflict = /same name|equivalent index|already exists/i.test(err.message);
      const status = isConflict ? 'CONFLICT' : 'ERROR';
      results.push({ model: Model.modelName, status, error: err.message });
      console.error(`  ${isConflict ? '⚠️' : '❌'} ${Model.modelName}: ${status} — ${err.message}`);
      if (!isConflict) console.error(err.stack);
    }
  }

  await mongoose.disconnect();
  console.log('\n🏁 Resumo:');
  console.table(results);
}

ensureIndexes().catch((err) => {
  console.error('❌ Falha ao garantir índices:', err.message);
  process.exit(1);
});
