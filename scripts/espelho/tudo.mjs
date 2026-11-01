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
    console.log('[espelho] subindo o MongoDB local em segundo plano...');
    await run('mongo-local.mjs', { detached: true, stdio: 'ignore' });
    for (let i = 0; i < 60 && !(await portOpen()); i++) await new Promise((r) => setTimeout(r, 1000));
    await new Promise((r) => setTimeout(r, 4000)); // replica set elegendo primário
  }
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
  await run('dev.mjs');
} catch (err) {
  console.error('[espelho] ❌', err.message);
  process.exit(1);
}
