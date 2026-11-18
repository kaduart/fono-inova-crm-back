// Medição de memória do conector (18/11/2026). Uso: NODE_PATH=<node_modules com whatsapp-web.js e puppeteer-core> node --expose-gc scripts/measure-memory.mjs
// CHROME_PATH muda o Chrome do item 3. Resultados e leitura em docs/WHATSAPP_CONECTOR_EXTERNO.md (CRM).
import { spawn } from 'child_process';
import net from 'net';
import { processTreeMemory } from '../src/procMem.js';
import { signRequest, SIGNATURE_HEADER } from '../src/contract.js';
const mb = (n) => Math.round(n / 1048576);
const out = {};
// 1) Node do conector com o motor real carregado (whatsapp-web.js + qrcode + motor), sem abrir Chrome.
{
  global.gc?.(); const a = mb(process.memoryUsage().rss);
  const { default: wweb } = await import('whatsapp-web.js'); await import('qrcode'); const { createWhatsAppEngine } = await import('../src/engine.js');
  await import('../src/app.js'); await import('../src/eventOutbox.js'); await import('../src/idempotencyStore.js');
  createWhatsAppEngine({ lib: wweb, authPath: '/tmp/x' });
  global.gc?.(); out.nodeMotorRealSemChrome = { antes: a, depois: mb(process.memoryUsage().rss) };
}
// 2) Processo do conector (simulador) parado e sob carga de 1000 envios: RSS medido de fora (/proc).
{
  const SECRET = 'm'.repeat(40);
  const port = await new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
  const c = spawn(process.execPath, ['src/index.js'], { cwd: new URL('..', import.meta.url).pathname, env: { PATH: process.env.PATH, WA_CONNECTOR_ENGINE: 'simulator', WA_CONNECTOR_SECRET: SECRET, CRM_EVENTS_URL: 'https://x/y', WA_CONNECTOR_DATA_DIR: `/tmp/claude-0/measure/c-${Date.now()}`, PORT: String(port), WA_CONNECTOR_SEND_MIN_INTERVAL_MS: '0' } });
  await new Promise((r) => c.stdout.on('data', (d) => { if (String(d).includes('🟢')) r(); }));
  await new Promise((r) => setTimeout(r, 500));
  const idle = processTreeMemory(c.pid).rssMB; let peak = idle;
  for (let i = 0; i < 1000; i++) {
    const body = JSON.stringify({ requestId: `r${i}`, phone: '5562999990000', text: 'x'.repeat(300) });
    await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', body, headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signRequest(SECRET, { method: 'POST', path: '/v1/messages', body }) } });
    if (i % 100 === 0) peak = Math.max(peak, processTreeMemory(c.pid).rssMB);
  }
  out.processoConectorSimulador = { parado: idle, picoCom1000Envios: Math.max(peak, processTreeMemory(c.pid).rssMB) };
  c.kill('SIGTERM');
}
// 3) Piso do Chrome: mesmos flags do motor, aba em about:blank (SEM WhatsApp Web — rede bloqueada aqui).
{
  const { default: puppeteer } = await import('puppeteer-core');
  const { chromeArgs } = await import('../src/engine.js');
  const b = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome', headless: 'new', args: chromeArgs({ jsHeapMb: 1024 }) });
  const p = await b.newPage(); await p.goto('about:blank'); await new Promise((r) => setTimeout(r, 3000));
  const t = processTreeMemory(b.process().pid);
  out.chromePisoAboutBlank = { processos: t.processes, rssMB: t.rssMB, pssMB: t.pssMB, porProcesso: t.procs.map((x) => `${x.name}:${x.rssMB}/${x.pssMB}`) };
  await b.close();
}
console.log(JSON.stringify(out));
process.exit(0);
