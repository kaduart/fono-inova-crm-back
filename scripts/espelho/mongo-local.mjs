#!/usr/bin/env node
/**
 * 🪞 Sobe o MongoDB local do espelho (replica set de 1 nó, porta 27018).
 * Fica rodando em primeiro plano — deixe esta janela aberta. Ctrl+C para parar.
 *
 *   npm run espelho:mongo
 */
import fs from 'fs';
import { spawn } from 'child_process';
import { MongoClient } from 'mongodb';
import { PORT, REPLSET, DATA_DIR, MONGOD_PATH } from './config.mjs';

const TAG = '[espelho:mongo]';
if (!fs.existsSync(MONGOD_PATH)) {
  console.error(`${TAG} ❌ mongod não encontrado em ${MONGOD_PATH} (defina MONGOD_PATH)`);
  process.exit(1);
}
fs.mkdirSync(DATA_DIR, { recursive: true });

const mongod = spawn(MONGOD_PATH, ['--dbpath', DATA_DIR, '--port', String(PORT), '--bind_ip', '127.0.0.1', '--replSet', REPLSET, '--quiet'], { stdio: ['ignore', 'inherit', 'inherit'] }); // 01/11: saída vai para o log do tudo.mjs
mongod.on('exit', (code) => { console.log(`${TAG} mongod saiu (código ${code})`); process.exit(code ?? 0); });
process.on('SIGINT', () => mongod.kill('SIGINT'));

// Inicializa o replica set na primeira vez (idempotente)
const client = new MongoClient(`mongodb://127.0.0.1:${PORT}/?directConnection=true`, { serverSelectionTimeoutMS: 30_000 });
try {
  await client.connect();
  const admin = client.db('admin');
  try { await admin.command({ replSetGetStatus: 1 }); }
  catch { await admin.command({ replSetInitiate: { _id: REPLSET, members: [{ _id: 0, host: `127.0.0.1:${PORT}` }] } }); }
  for (let i = 0; i < 30 && !(await admin.command({ hello: 1 })).isWritablePrimary; i++) await new Promise((r) => setTimeout(r, 1000));
  console.log(`${TAG} ✅ MongoDB do espelho pronto em 127.0.0.1:${PORT} (dados em ${DATA_DIR}). Deixe esta janela aberta.`);
} catch (err) {
  console.error(`${TAG} ❌ ${err.message}`);
} finally {
  await client.close();
}
