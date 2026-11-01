#!/usr/bin/env node
// Desliga o Mongo local do espelho (porta 27018) com segurança.
import { MongoClient } from 'mongodb';
import { PORT } from './config.mjs';
const c = new MongoClient(`mongodb://127.0.0.1:${PORT}/?directConnection=true`, { serverSelectionTimeoutMS: 3000 });
try {
  await c.connect();
  await c.db('admin').command({ shutdown: 1, force: true }).catch(() => {});
  console.log('[espelho] Mongo local desligado.');
} catch { console.log('[espelho] Mongo local já estava desligado.'); }
finally { await c.close().catch(() => {}); }
