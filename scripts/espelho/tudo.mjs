#!/usr/bin/env node
/**
 * 🪞 UM comando só: sobe o Mongo local (se não estiver rodando), copia a produção
 * de agora e sobe o back local em cima da cópia.
 *
 *   npm run espelho            → cópia nova + back
 *   npm run espelho -- --sem-copia   → reaproveita a última cópia (sobe em segundos)
 */
import net from 'net';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { PORT } from './config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const run = (file, opts = {}) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [path.join(here, file)], { stdio: 'inherit', ...opts });
  if (opts.detached) { p.unref(); return resolve(); }
  p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${file} saiu com código ${code}`))));
});
const portOpen = () => new Promise((r) => { const s = net.connect(PORT, '127.0.0.1'); s.on('connect', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); });

try {
  if (!(await portOpen())) {
    console.log('[espelho] subindo o MongoDB local em segundo plano...');
    await run('mongo-local.mjs', { detached: true, stdio: 'ignore' });
    for (let i = 0; i < 60 && !(await portOpen()); i++) await new Promise((r) => setTimeout(r, 1000));
    await new Promise((r) => setTimeout(r, 4000)); // replica set elegendo primário
  }
  if (!process.argv.includes('--sem-copia')) await run('copiar.mjs');
  await run('dev.mjs');
} catch (err) {
  console.error('[espelho] ❌', err.message);
  process.exit(1);
}
