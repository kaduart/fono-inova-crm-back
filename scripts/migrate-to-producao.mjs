#!/usr/bin/env node
/**
 * 🚚 Migração one-shot: banco de produção do Cluster0 (compartilhado com dev)
 *    → cluster "Producao" (projeto Atlas separado).
 *
 * - Merge por _id: insere só o que falta no destino; documento que já existe
 *   NUNCA é sobrescrito (só é contado se estiver diferente). Nunca usa drop.
 * - Idempotente: rodar de novo não duplica nem altera.
 * - Copia os índices das coleções.
 * - SECO por padrão; --write grava.
 *
 * Credenciais (só por env, nunca em arquivo):
 *   MIGRATION_SOURCE_URI  Cluster0, banco atual de produção (ex.: .../fono_inova_prod_rec1021)
 *   MIGRATION_TARGET_URI  cluster Producao, usuário TEMPORÁRIO de migração (apagar após rodar)
 *
 * Uso:
 *   node scripts/migrate-to-producao.mjs            # seco
 *   node scripts/migrate-to-producao.mjs --write
 *   node scripts/migrate-to-producao.mjs --write --sync   # na virada, com a API parada
 */

import { MongoClient } from 'mongodb';

const WRITE = process.argv.includes('--write');
// --sync (só na virada, com a API parada): a ORIGEM vence nos divergentes — usado
// para levar ao destino o que mudou na origem depois da 1ª cópia. Nunca apaga.
const SYNC = process.argv.includes('--sync');
const SRC = process.env.MIGRATION_SOURCE_URI;
const DST = process.env.MIGRATION_TARGET_URI;
const TAG = '[migrate-producao]';
const BATCH = 500;

if (!SRC || !DST) {
  console.error(`${TAG} defina MIGRATION_SOURCE_URI e MIGRATION_TARGET_URI`);
  process.exit(1);
}
const host = (uri) => uri.replace(/^mongodb(\+srv)?:\/\//, '').replace(/^[^@/]*@/, '').split(/[/?]/)[0].toLowerCase();
const dbName = (uri) => (uri.match(/mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/) || [])[1];
if (!dbName(SRC) || !dbName(DST)) { console.error(`${TAG} as duas URIs precisam do nome do banco`); process.exit(1); }
if (host(SRC) === host(DST)) { console.error(`${TAG} origem e destino no MESMO cluster — abortando`); process.exit(1); }

const src = new MongoClient(SRC, { maxPoolSize: 3 });
const dst = new MongoClient(DST, { maxPoolSize: 3 });
const ordered = (v) => Array.isArray(v) ? v.map(ordered) : v && typeof v === 'object' && !(v instanceof Date) && !v._bsontype
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, ordered(v[k])])) : v;
const semantic = (d) => JSON.stringify(ordered(d));
const idKey = (id) => (id && id._bsontype) ? String(id) : JSON.stringify(ordered(id));

try {
  await src.connect(); await dst.connect();
  const S = src.db(), T = dst.db();
  console.log(`${TAG} ${WRITE ? 'GRAVANDO' : 'SECO'}: ${host(SRC)}/${S.databaseName} → ${host(DST)}/${T.databaseName}`);
  const totals = { origem: 0, inseridos: 0, jaExistiam: 0, divergentes: 0 };
  const rows = [];
  for (const { name } of await S.listCollections({ type: 'collection' }).toArray()) {
    if (name.startsWith('system.')) continue;
    const docs = await S.collection(name).find({}).toArray();
    const existing = new Map();
    for (let i = 0; i < docs.length; i += 5000) {
      const ids = docs.slice(i, i + 5000).map((d) => d._id);
      for (const d of await T.collection(name).find({ _id: { $in: ids } }).toArray()) existing.set(idKey(d._id), d);
    }
    const missing = docs.filter((d) => !existing.has(idKey(d._id)));
    const divergingDocs = docs.filter((d) => existing.has(idKey(d._id)) && semantic(existing.get(idKey(d._id))) !== semantic(d));
    const diverging = divergingDocs.length;
    let inserted = 0;
    if (WRITE && SYNC) for (const d of divergingDocs) await T.collection(name).replaceOne({ _id: d._id }, d);
    if (WRITE) {
      if (!docs.length) await T.createCollection(name).catch(() => {});
      for (let i = 0; i < missing.length; i += BATCH) {
        const r = await T.collection(name).insertMany(missing.slice(i, i + BATCH), { ordered: false });
        inserted += r.insertedCount;
      }
      const idx = (await S.collection(name).listIndexes().toArray()).filter((x) => x.name !== '_id_').map(({ v, ns, ...rest }) => rest);
      if (idx.length) await T.collection(name).createIndexes(idx).catch((e) => console.warn(`${TAG} ⚠️ índice ${name}: ${e.message}`));
      const after = await T.collection(name).countDocuments();
      if (after < docs.length) throw new Error(`${name}: destino ficou com ${after} < origem ${docs.length}`);
    }
    totals.origem += docs.length; totals.inseridos += inserted; totals.jaExistiam += existing.size; totals.divergentes += diverging;
    rows.push({ colecao: name, origem: docs.length, faltando: missing.length, inseridos: WRITE ? inserted : '-', jaExistiam: existing.size, divergentes: diverging });
  }
  console.table(rows.filter((r) => r.origem));
  console.log(`${TAG} TOTAL`, totals);
  if (totals.divergentes) console.log(`${TAG} ${SYNC && WRITE ? '🔄' : '⚠️'} ${totals.divergentes} documento(s) divergentes — ${SYNC && WRITE ? 'atualizados com a versão da origem' : 'mantidos como estão (use --sync na virada)'}.`);
} catch (err) {
  console.error(`${TAG} ❌ ${err.message}`);
  process.exitCode = 1;
} finally {
  await src.close(); await dst.close();
}
