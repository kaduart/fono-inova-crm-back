/**
 * Sem WHATSAPP_CONNECTOR_MODE (o padrão de hoje em produção): o crm-worker sobe exatamente como antes —
 * cria o processo filho do Chrome (whatsapp-child.js), manda o "reconectar" para ele e NÃO carrega nem
 * inicializa nada do conector externo. Roda o entrypoint real (workers/entrypoints/whatsapp-only.js) num
 * processo separado; o preload tests/support/recordWhatsappBoot.mjs anota cada módulo carregado e troca o
 * fork por um falso (nenhum Chrome é aberto). Mongo ausente e Redis apontando para porta fechada.
 * O mesmo boot com WHATSAPP_CONNECTOR_MODE=external serve de contraprova.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import net from 'net';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONNECTOR_CODE = /\/(services\/whatsappConnector\/|workers\/whatsappConnectorBridge\.js|whatsapp-connector\/)/;

async function boot(extraEnv) {
  const port = await freePort();
  const record = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-boot-')), 'boot.json');
  const env = {
    PATH: process.env.PATH,
    ...(process.env.NODE_PATH ? { NODE_PATH: process.env.NODE_PATH } : {}),
    PORT: String(port),
    WA_BOOT_RECORD: record,
    OPENAI_API_KEY: 'teste',
    INTERNAL_BASE_URL: 'http://127.0.0.1:1',
    REDIS_URL: 'redis://127.0.0.1:1',
    ...extraEnv,
  };
  const child = spawn(process.execPath, ['--import', './tests/support/recordWhatsappBoot.mjs', 'workers/entrypoints/whatsapp-only.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  let status = null;
  for (let i = 0; i < 120 && !status; i++) {
    await sleep(250);
    try { status = await (await fetch(`${base}/api/whatsapp-web/status`)).json(); } catch { /* ainda subindo */ }
  }
  let reconnect = null;
  try { reconnect = await (await fetch(`${base}/api/whatsapp-web/reconnect`, { method: 'POST' })).json(); } catch { /* */ }
  await sleep(1500); // dá tempo de imports dinâmicos pós-boot aparecerem
  child.kill('SIGKILL');
  const rec = fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, 'utf8')) : { loaded: [], forks: [], childMessages: [] };
  return { status, reconnect, log, ...rec };
}

describe('crm-worker sem WHATSAPP_CONNECTOR_MODE: caminho atual intacto', () => {
  it('cria o filho do Chrome, repassa o reconectar a ele e não carrega o conector externo', async () => {
    const r = await boot({});
    expect(r.status, r.log.slice(-2000)).not.toBeNull();
    expect(r.forks).toHaveLength(1);
    expect(r.forks[0]).toMatch(/workers\/entrypoints\/whatsapp-child\.js$/);
    expect(r.reconnect).toMatchObject({ success: true });
    expect(r.childMessages).toContainEqual({ type: 'reconnect_request' });
    expect(r.loaded.length).toBeGreaterThan(100); // o boot real carregou models, workers etc.
    expect(r.loaded.filter((u) => CONNECTOR_CODE.test(u))).toEqual([]);
    expect(r.log).not.toMatch(/WHATSAPP_CONNECTOR_MODE=external|ponte do conector/i);
  }, 60_000);

  it('contraprova: com WHATSAPP_CONNECTOR_MODE=external não há filho e o reconectar vai ao conector', async () => {
    const r = await boot({ WHATSAPP_CONNECTOR_MODE: 'external', WA_CONNECTOR_URL: 'http://127.0.0.1:1', WA_CONNECTOR_SECRET: 's'.repeat(40) });
    expect(r.status, r.log.slice(-2000)).not.toBeNull();
    expect(r.forks).toEqual([]);
    // A ponte só sobe depois dos workers core (que esperam o Redis, fechado aqui); o reconectar já usa o conector.
    expect(r.loaded.some((u) => /services\/whatsappConnector\/client\.js$/.test(u))).toBe(true);
    expect(r.reconnect).toMatchObject({ success: false }); // conector inalcançável: falha visível, sem filho
  }, 60_000);

  it('o processo filho do modo local (whatsapp-child.js) não importa o conector', () => {
    const seen = new Set();
    const stack = [path.join(ROOT, 'workers/entrypoints/whatsapp-child.js')];
    const re = /(?:import\s[^'"]*?from\s*|import\s*\(\s*|import\s+)['"](\.[^'"]+)['"]/g;
    while (stack.length) {
      const f = stack.pop();
      if (seen.has(f)) continue;
      seen.add(f);
      for (const m of fs.readFileSync(f, 'utf8').matchAll(re)) {
        let p = path.resolve(path.dirname(f), m[1]);
        if (!fs.existsSync(p) && fs.existsSync(`${p}.js`)) p = `${p}.js`;
        if (fs.existsSync(p) && fs.statSync(p).isFile()) stack.push(p);
      }
    }
    const hits = [...seen].map((f) => `/${path.relative(ROOT, f)}`).filter((f) => CONNECTOR_CODE.test(f));
    expect(hits).toEqual([]);
  });
});
