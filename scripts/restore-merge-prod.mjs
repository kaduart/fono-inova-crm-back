#!/usr/bin/env node
/**
 * Restauração por MERGE do fono_inova_prod (incidente 2026-10-21: banco apagado).
 *
 * Insere de volta os documentos do mongodump de 02/07/2026 SEM apagar nada no
 * destino: só entra documento cujo _id ainda não existe lá. O que o Render já
 * gravou depois da exclusão é preservado. Idempotente: rodar de novo não duplica.
 *
 * Uso:
 *   node scripts/restore-merge-prod.mjs                       # SECO: só conta
 *   node scripts/restore-merge-prod.mjs --write               # grava
 *   node scripts/restore-merge-prod.mjs --only=patients,appointments
 *   node scripts/restore-merge-prod.mjs --target=fono_inova_restore_teste --write
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { MongoClient, BSON } from 'mongodb';

dotenv.config();

const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const WRITE = process.argv.includes('--write');
const TARGET = arg('target') || 'fono_inova_prod';
const ONLY = arg('only')?.split(',').filter(Boolean);
const DUMP_DIR = path.resolve(process.cwd(), 'backups-mongo/pre-backfill-guidePolicy-20260702_160927/fono_inova_prod');
const BATCH = 500;

function readBson(file) {
  const buf = fs.readFileSync(file);
  const docs = [];
  for (let i = 0; i < buf.length;) {
    const size = buf.readInt32LE(i);
    docs.push(BSON.deserialize(buf.subarray(i, i + size), { promoteBuffers: true }));
    i += size;
  }
  return docs;
}

const client = new MongoClient(process.env.MONGO_URI || process.env.MONGODB_URI);
await client.connect();
const target = client.db(TARGET);

// Nunca restaurar: estado de sessão do WhatsApp (o Render já recriou o 'main') e
// filas/agendamentos de ENVIO — o worker vivo dispararia mensagens velhas de julho.
const SKIP = new Set(['whatsappwebstates', 'baileyssessions', 'outboxes', 'reminders']);

// Neutraliza envios automáticos pendentes dentro dos documentos restaurados
const SANITIZE = {
  followups: (d) => (d.status === 'scheduled' ? null : d),
  leads: (d) => {
    if (d.recovery?.nextAttemptAt && !d.recovery?.finishedAt && !d.recovery?.cancelledAt) {
      d.recovery.nextAttemptAt = null; // Amanda recovery só dispara com nextAttemptAt <= agora
    }
    return d;
  },
};

const collections = fs.readdirSync(DUMP_DIR)
  .filter((f) => f.endsWith('.bson'))
  .map((f) => f.replace(/\.bson$/, ''))
  .filter((n) => !n.startsWith('system.') && !SKIP.has(n) && (!ONLY || ONLY.includes(n)))
  .sort();

console.log(`Fonte: dump 02/07 | Destino: ${TARGET} | Modo: ${WRITE ? 'GRAVAÇÃO' : 'SECO'} | ${collections.length} coleções\n`);
const totals = { source: 0, missing: 0, inserted: 0 };

for (const name of collections) {
  const raw = readBson(path.join(DUMP_DIR, `${name}.bson`));
  const docs = SANITIZE[name] ? raw.map(SANITIZE[name]).filter(Boolean) : raw;
  if (docs.length !== raw.length) console.log(`   (${name}: ${raw.length - docs.length} pendentes de envio ignorados)`);
  if (!docs.length) continue;

  const col = target.collection(name);
  const existing = new Set();
  for (let i = 0; i < docs.length; i += 5000) {
    const ids = docs.slice(i, i + 5000).map((d) => d._id);
    for (const d of await col.find({ _id: { $in: ids } }, { projection: { _id: 1 } }).toArray()) existing.add(String(d._id));
  }
  const missing = docs.filter((d) => !existing.has(String(d._id)));

  let inserted = 0;
  const errors = [];
  if (WRITE) {
    for (let i = 0; i < missing.length; i += BATCH) {
      try {
        const r = await col.insertMany(missing.slice(i, i + BATCH), { ordered: false });
        inserted += r.insertedCount;
      } catch (e) {
        // ordered:false: o lote segue; conflito de índice único (doc recriado pelo Render) fica de fora
        inserted += e.result?.insertedCount ?? e.insertedCount ?? 0;
        errors.push(...(e.writeErrors || [e]).map((w) => w.errmsg || w.message).slice(0, 3));
      }
    }
  }
  totals.source += docs.length; totals.missing += missing.length; totals.inserted += inserted;
  console.log(`${name.padEnd(40)} fonte=${String(docs.length).padStart(6)} ja_no_destino=${String(existing.size).padStart(6)} faltando=${String(missing.length).padStart(6)}${WRITE ? ` inseridos=${inserted}` : ''}`);
  for (const e of errors) console.log(`   ⚠️ ${e}`);
}

console.log(`\nTOTAL fonte=${totals.source} faltando=${totals.missing}${WRITE ? ` inseridos=${totals.inserted}` : ' (seco — nada gravado)'}`);
await client.close();
