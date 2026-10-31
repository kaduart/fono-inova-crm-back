#!/usr/bin/env node
/**
 * 🪞⏰ Atualização diária do espelho (roda pelo Agendador de Tarefas do Windows às 18:50).
 * Sobe o Mongo local se estiver parado e recopia a produção (só leitura) já anonimizada.
 * NÃO sobe o back. Para cópia crua: npm run espelho:diario -- --cru
 *
 *   npm run espelho:diario
 */
import net from 'net';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { PORT } from './config.mjs';

const TAG = `[espelho:diario ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}]`;
const here = path.dirname(fileURLToPath(import.meta.url));
const portOpen = () => new Promise((r) => { const s = net.connect(PORT, '127.0.0.1'); s.on('connect', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  if (!(await portOpen())) {
    console.log(`${TAG} subindo o MongoDB local...`);
    spawn(process.execPath, [path.join(here, 'mongo-local.mjs')], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    for (let i = 0; i < 60 && !(await portOpen()); i++) await sleep(1000);
    if (!(await portOpen())) throw new Error('MongoDB local não subiu');
    await sleep(4000);
  }
  const args = process.argv.includes('--cru') ? [] : ['--anonimizar'];
  // até 3 tentativas (rede/Atlas instável), com espera crescente
  for (let tentativa = 1; ; tentativa++) {
    const code = await new Promise((res) => spawn(process.execPath, [path.join(here, 'copiar.mjs'), ...args], { stdio: 'inherit', windowsHide: true }).on('exit', res));
    if (code === 0) break;
    if (tentativa === 3) throw new Error(`cópia falhou 3 vezes (código ${code})`);
    console.log(`${TAG} tentativa ${tentativa} falhou, nova tentativa em ${tentativa} min`);
    await sleep(tentativa * 60_000);
  }
  console.log(`${TAG} ✅ espelho atualizado`);
} catch (err) {
  console.error(`${TAG} ❌ ${err.message}`);
  process.exit(1);
}
