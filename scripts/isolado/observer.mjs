// scripts/isolado/observer.mjs
// Observador do ambiente integrado: lê o change stream do banco isolado e
// grava uma linha JSON por alteração em eventstore e kas_event_reaper_lease
// (sem payload). Serve de prova independente dos logs dos processos:
// quem tinha a posse em cada instante e se cada recuperação foi cercada
// (gravada na mesma transação que a confirmação da posse).
import fs from 'node:fs';
import mongoose from 'mongoose';
import { requireIsolatedMongo } from './_guard.mjs';

const { uri } = requireIsolatedMongo();
const out = fs.createWriteStream(process.argv[2] || '/tmp/observer.jsonl', { flags: 'a' });
await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
const db = mongoose.connection.db;
const stream = db.watch(
  [{ $match: { 'ns.coll': { $in: ['eventstore', 'kas_event_reaper_lease'] } } }],
  { fullDocument: 'updateLookup' }
);
console.log(JSON.stringify({ msg: 'observer_ready' }));
for await (const ch of stream) {
  const coll = ch.ns.coll;
  const rec = {
    t: `${ch.clusterTime.high}.${ch.clusterTime.low}`,
    coll,
    op: ch.operationType,
    id: String(ch.documentKey?._id),
    txn: ch.txnNumber != null ? `${ch.lsid?.id?.toString('hex') ?? ''}:${ch.txnNumber}` : null,
    set: ch.updateDescription ? Object.keys(ch.updateDescription.updatedFields || {}) : undefined,
    unset: ch.updateDescription?.removedFields
  };
  const f = ch.fullDocument || {};
  if (coll === 'kas_event_reaper_lease') {
    // Valores da PRÓPRIA alteração (updatedFields), não do documento lido
    // depois (updateLookup pode já refletir uma troca posterior).
    const uf = ch.updateDescription?.updatedFields || {};
    // insert/replace trazem o documento novo inteiro (do próprio instante).
    const doc = ch.operationType === 'insert' || ch.operationType === 'replace' ? f : uf;
    rec.holder = doc.holder ?? null;
    rec.token = doc.token ? String(doc.token).slice(0, 8) : null;
  } else {
    rec.eventId = f.eventId;
    rec.status = ch.updateDescription?.updatedFields?.status ?? f.status;
    rec.recoveryCount = f.recoveryCount;
  }
  out.write(JSON.stringify(rec) + '\n');
}
