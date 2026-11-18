// Ensaio com a biblioteca whatsapp-web.js REAL e Chrome REAL, sem sessão real (18/11/2026).
// Sem acesso a web.whatsapp.com o init falha: confere que o motor abre o Chrome com a sessão na pasta indicada,
// derruba a árvore inteira a cada falha, reinicia com espera, para em "failed" ao passar do limite de reinícios
// e, no stop, não deixa nenhum processo Chrome vivo. NÃO escaneie QR aqui: a pasta é temporária e descartada.
// Uso: NODE_PATH=<node_modules com whatsapp-web.js> CHROME_PATH=<chrome> node scripts/smoke-real-lib.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { createWhatsAppEngine } from '../src/engine.js';
import { processTreeMemory } from '../src/procMem.js';

const require = createRequire(import.meta.url);
const wweb = require('whatsapp-web.js');
const authPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-smoke-'));
const log = [];
const logger = { log: (...a) => log.push(a.join(' ')), warn: (...a) => log.push(a.join(' ')), error: (...a) => log.push(a.join(' ')) };
const engine = createWhatsAppEngine({
  lib: wweb, authPath, executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome',
  toQrDataUrl: async (q) => `qr:${q.length}`, logger, initTimeoutMs: 20_000, restartBackoffMs: [2000], catchUpDelayMs: 1e12,
});
const chromePids = () => fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)).filter((p) => { try { return fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').includes(authPath); } catch { return false; } }).length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { lib: require('whatsapp-web.js/package.json').version };
engine.start();
await sleep(8000);
out.aposAbrir = { status: (await engine.getStatus()).status, chromeComEstaSessao: chromePids(), arvore: processTreeMemory(engine.browserPid?.())?.processes ?? null };
await sleep(20_000);
out.aposWatchdog = { status: (await engine.getStatus()).status, motivo: (await engine.getStatus()).lastDisconnectReason };
await sleep(10_000);
out.reiniciou = { status: (await engine.getStatus()).status, chromeComEstaSessao: chromePids() };
await engine.stop();
await sleep(2000);
out.aposStop = { status: (await engine.getStatus()).status, chromeComEstaSessao: chromePids() };
out.sessaoPerm = (fs.statSync(authPath).mode & 0o777).toString(8);
console.log(JSON.stringify(out, null, 1));
console.log(log.filter((l) => /init|reinic|Chrome|QR|qr|restart/i.test(l)).slice(0, 12).join('\n'));
fs.rmSync(authPath, { recursive: true, force: true });
process.exit(0);
