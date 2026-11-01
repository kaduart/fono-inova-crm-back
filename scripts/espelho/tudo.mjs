#!/usr/bin/env node
/**
 * 🪞 UM comando só: sobe o Mongo local (27018) e o Redis exclusivo do espelho (6381),
 * copia o espelho da nuvem (fono-dev, anonimizado) — ou a produção só leitura, se não houver —
 * e sobe o back local em cima da cópia.
 *
 * 01/11 (Kadu): a cópia é AUTOMÁTICA uma vez por dia. Na primeira subida do dia copia
 * (~2 min); nas outras (ou após reinício) reaproveita a cópia e sobe em segundos.
 *
 *   npm run dev / npm run espelho      → copia se a última cópia não é de hoje
 *   npm run espelho -- --copiar        → força cópia nova agora
 *   npm run espelho -- --sem-copia     → nunca copia (usa a que está lá)
 *   npm run dev:atlas                  → modo antigo (Atlas de dev, sem espelho)
 */
import net from 'net';
import fs from 'fs';
import os from 'os';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { PORT, BACK_DIR } from './config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const run = (file, opts = {}) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [path.join(here, file)], { stdio: 'inherit', ...opts });
  if (opts.detached) { p.unref(); return resolve(); }
  p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${file} saiu com código ${code}`))));
});
const portOpen = (port = PORT) => new Promise((r) => { const s = net.connect(port, '127.0.0.1'); s.on('connect', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); });

const MONGO_LOG = path.join(BACK_DIR, '.local', 'mongo-espelho.log');
// 01/11: esperar o replica set aceitar escrita de verdade (porta aberta não basta:
// o mongod abre a porta e ainda pode cair na recuperação ou estar sem primário).
async function waitMongoReady() {
  const { MongoClient } = await import('mongodb');
  for (let i = 0; i < 90; i++) {
    const c = new MongoClient(`mongodb://127.0.0.1:${PORT}/?directConnection=true`, { serverSelectionTimeoutMS: 1500 });
    try {
      await c.connect();
      if ((await c.db('admin').command({ hello: 1 })).isWritablePrimary) return;
    } catch { /* ainda subindo */ } finally { await c.close().catch(() => {}); }
    await new Promise((r) => setTimeout(r, 1000));
  }
  let tail = '';
  try { tail = fs.readFileSync(MONGO_LOG, 'utf8').split(/\r?\n/).slice(-15).join('\n'); } catch {}
  throw new Error(`MongoDB local não ficou pronto em 90s na porta ${PORT}.\nÚltimas linhas de ${MONGO_LOG}:\n${tail}`);
}

// 01/11 (Kadu): só ele usa o localhost. Com ESPELHO_MEU_EMAIL no .env, a conta de teste
// admin@espelho.local passa a usar esse e-mail (a senha continua a de teste,
// ESPELHO_SYNC_TEST_PASSWORD). Idempotente; roda a cada subida, só no Mongo local.
async function loginDoDono() {
  let email = process.env.ESPELHO_MEU_EMAIL || '';
  if (!email) { // lê só esta chave do .env (não carrega as credenciais no processo)
    try { email = (fs.readFileSync(path.join(BACK_DIR, '.env'), 'utf8').match(/^ESPELHO_MEU_EMAIL=(.*)$/m) || [])[1] || ''; } catch {}
  }
  email = email.replace(/^["']|["']\s*$/g, '').trim().toLowerCase();
  if (!email) return;
  const { MongoClient } = await import('mongodb');
  const { URI } = await import('./config.mjs');
  const c = new MongoClient(URI, { serverSelectionTimeoutMS: 5000 });
  try {
    await c.connect();
    const admins = c.db().collection('admins');
    if (await admins.findOne({ email })) { console.log(`[espelho] login do dono: ${email}`); return; }
    const r = await admins.updateOne({ email: 'admin@espelho.local' }, { $set: { email } });
    console.log(r.modifiedCount ? `[espelho] login do dono: ${email} (senha de teste)` : '[espelho] ⚠️ conta admin@espelho.local não achada na cópia');
  } finally { await c.close(); }
}

const REDIS_PORT = 6381; // o mesmo de environment.mjs
const MARKER = path.join(BACK_DIR, '.local', 'mongo-espelho', 'ultima-copia.txt');
const hojeSP = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const ultimaCopia = () => { try { return fs.readFileSync(MARKER, 'utf8').trim(); } catch { return ''; } };

// Redis exclusivo do espelho (não mistura filas com o Redis do modo Atlas, porta 6379).
async function ensureRedis() {
  if (await portOpen(REDIS_PORT)) return;
  const exe = process.platform === 'win32'
    ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Memurai', 'memurai.exe')
    : 'redis-server';
  if (process.platform === 'win32' && !fs.existsSync(exe)) throw new Error('Memurai não encontrado em Program Files (Redis do espelho).');
  const dir = path.join(BACK_DIR, '.local', 'redis-espelho');
  fs.mkdirSync(dir, { recursive: true });
  console.log(`[espelho] subindo o Redis do espelho (127.0.0.1:${REDIS_PORT})...`);
  const p = spawn(exe, ['--bind', '127.0.0.1', '--port', String(REDIS_PORT), '--dir', dir, '--appendonly', 'yes'],
    { cwd: dir, detached: true, windowsHide: true, stdio: 'ignore' });
  p.unref();
  for (let i = 0; i < 30 && !(await portOpen(REDIS_PORT)); i++) await new Promise((r) => setTimeout(r, 500));
  if (!(await portOpen(REDIS_PORT))) throw new Error(`Redis do espelho não respondeu na porta ${REDIS_PORT}`);
}

try {
  if (!(await portOpen())) {
    console.log(`[espelho] subindo o MongoDB local em segundo plano (log: ${MONGO_LOG})...`);
    fs.mkdirSync(path.dirname(MONGO_LOG), { recursive: true });
    const out = fs.openSync(MONGO_LOG, 'a');
    await run('mongo-local.mjs', { detached: true, windowsHide: true, stdio: ['ignore', out, out] });
    fs.closeSync(out);
  }
  await waitMongoReady();
  await ensureRedis();
  const forcar = process.argv.includes('--copiar');
  const nunca = process.argv.includes('--sem-copia');
  const ultima = ultimaCopia();
  if (!nunca && (forcar || ultima !== hojeSP())) {
    console.log(`[espelho] última cópia: ${ultima || 'nenhuma'} → copiando de novo (fonte no log abaixo)...`);
    await run('copiar.mjs');
    fs.mkdirSync(path.dirname(MARKER), { recursive: true });
    fs.writeFileSync(MARKER, hojeSP() + os.EOL);
  } else {
    console.log(`[espelho] usando a cópia de ${ultima || '(desconhecida)'}${nunca ? ' (--sem-copia)' : ' (já copiada hoje)'}`);
  }
  await loginDoDono();
  await run('dev.mjs');
} catch (err) {
  console.error('[espelho] ❌', err.message);
  process.exit(1);
}
