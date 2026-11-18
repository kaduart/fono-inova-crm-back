/**
 * Modo externo (WHATSAPP_CONNECTOR_MODE=external): o CRM nunca sobe Chrome — nem no boot, nem em
 * reconexão, recuperação, retry ou com o conector fora do ar. A falha fica visível (WhatsAppWebState) e
 * não existe fallback para navegador local. Sessão marcada como transferida também bloqueia o modo local.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const constructed = vi.hoisted(() => ({ n: 0, saved: [] }));
vi.mock('whatsapp-web.js', () => {
  class Client { constructor() { constructed.n++; } on() {} initialize() { return new Promise(() => {}); } destroy() {} }
  return { default: { Client, LocalAuth: class {}, Poll: class {} } };
});
vi.mock('wwebjs-mongo', () => ({ MongoStore: class {} }));
vi.mock('qrcode', () => ({ default: { toDataURL: async () => '' } }));
vi.mock('../../models/WhatsAppWebState.js', () => ({
  default: {
    findOneAndUpdate: vi.fn(async (_q, doc) => { constructed.saved.push(doc); return {}; }),
    findOne: () => ({ select: () => ({ lean: async () => null }), lean: async () => null }),
  },
}));
vi.mock('../../services/setPuppeteerCache.js', () => ({}));
vi.mock('bullmq', () => ({ Worker: class {} }));
vi.mock('../../config/redisConnection.js', () => ({ bullMqConnection: {} }));

const ROOT = path.resolve(__dirname, '../..');
const prevEnv = { ...process.env };
const restoreEnv = () => {
  for (const k of ['WHATSAPP_CONNECTOR_MODE', 'WHATSAPP_AUTH_PATH']) {
    if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k];
  }
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('modo externo: Chrome proibido no CRM', () => {
  let svc;
  beforeAll(async () => {
    vi.resetModules();
    process.env.WHATSAPP_CONNECTOR_MODE = 'external';
    svc = await import('../../services/whatsappWebJsService.js');
  });
  afterAll(restoreEnv);

  it('localChromeForbidden: só olha WHATSAPP_CONNECTOR_MODE', () => {
    expect(svc.localChromeForbidden({ WHATSAPP_CONNECTOR_MODE: 'external' })).toBe(true);
    expect(svc.localChromeForbidden({})).toBe(false);
    expect(svc.localChromeForbidden({ WHATSAPP_CONNECTOR_MODE: 'local' })).toBe(false);
  });

  it('boot, reconexão manual, soft reconnect e retry não criam o Client (Chrome)', async () => {
    constructed.n = 0;
    await svc.initWhatsAppClient();
    await svc.reconnect().catch(() => {});
    await svc.softReconnect().catch(() => {});
    await svc.initWhatsAppClient();
    expect(constructed.n).toBe(0);
  });

  it('envio pelo motor local falha como "não enviado" (nada de abrir navegador para tentar)', async () => {
    await expect(svc.sendMessage('5562999990000', 'oi')).rejects.toMatchObject({ deliveryNotSent: true });
    expect(constructed.n).toBe(0);
  });

  it('o crm-worker não cria o processo filho com Chrome no modo externo', async () => {
    const { shouldSpawnChromeChild } = await import('../../workers/entrypoints/whatsappMode.js');
    expect(shouldSpawnChromeChild({ WHATSAPP_CONNECTOR_MODE: 'external' })).toBe(false);
    expect(shouldSpawnChromeChild({})).toBe(true);
    // Único fork do entrypoint fica dentro de spawnWhatsAppChild, que começa pela guarda.
    const src = fs.readFileSync(path.join(ROOT, 'workers/entrypoints/whatsapp-only.js'), 'utf8');
    expect(src.match(/\bfork\(/g)).toHaveLength(1);
    const fn = src.slice(src.indexOf('function spawnWhatsAppChild() {'));
    expect(fn.indexOf('shouldSpawnChromeChild()')).toBeGreaterThan(0);
    expect(fn.indexOf('shouldSpawnChromeChild()')).toBeLessThan(fn.indexOf('fork('));
  });
});

describe('conector fora do ar: falha visível, sem fallback', () => {
  it('3 leituras sem resposta → connector_unreachable com o motivo; envio não sai e não abre Chrome', async () => {
    vi.resetModules();
    process.env.WHATSAPP_CONNECTOR_MODE = 'external';
    constructed.n = 0;
    const { createConnectorClient } = await import('../../services/whatsappConnector/client.js');
    const { makeStatusPoller, makeConnectorSender } = await import('../../workers/whatsappConnectorBridge.js');
    // Porta que acabou de fechar: conexão recusada (conector fora).
    const net = await import('net');
    const port = await new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
    const client = createConnectorClient({ baseUrl: `http://127.0.0.1:${port}`, secret: 'x'.repeat(40), timeoutMs: 500 });

    const written = [];
    const states = [];
    const poll = makeStatusPoller({ client, writeState: async (d) => { written.push(d); }, onState: (d) => states.push(d), logger: { error() {}, warn() {}, log() {} } });
    expect(await poll()).toBeNull();
    expect(await poll()).toBeNull();
    const doc = await poll();
    expect(doc).toMatchObject({ status: 'connector_unreachable', ready: false });
    expect(doc.lastDisconnectReason).toMatch(/conector sem resposta/);
    expect(written.at(-1).status).toBe('connector_unreachable');

    const DeliveryOutcome = { SENT: 'sent', ALREADY_SENT: 'already_sent', IN_PROGRESS: 'in_progress', UNCERTAIN: 'uncertain' };
    const guardedSend = async ({ send }) => { const out = await send(); return { outcome: DeliveryOutcome.SENT, result: out }; };
    const sender = makeConnectorSender({ client, guardedSend, DeliveryOutcome });
    await expect(sender({ id: '1' }, '5562999990000', 'oi')).rejects.toMatchObject({ deliveryNotSent: true, unavailable: true });

    expect(constructed.n).toBe(0);
    restoreEnv();
  });
});

describe('sessão transferida para o conector: modo local não abre Chrome', () => {
  let dir;
  afterAll(() => { restoreEnv(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

  it('com o marcador, initWhatsAppClient não cria Client e grava session_transferred (visível no ERP)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-auth-'));
    fs.writeFileSync(path.join(dir, '.session-transferred.json'), JSON.stringify({ to: 'conector-1', at: '2026-11-18T21:00:00Z' }));
    vi.resetModules();
    delete process.env.WHATSAPP_CONNECTOR_MODE; // alguém tirou a variável por engano
    process.env.WHATSAPP_AUTH_PATH = dir;
    constructed.n = 0;
    constructed.saved.length = 0;
    const svc = await import('../../services/whatsappWebJsService.js');
    expect(svc.sessionTransferredInfo(dir)).toMatchObject({ to: 'conector-1' });
    await svc.initWhatsAppClient();
    expect(constructed.n).toBe(0);
    expect(constructed.saved.at(-1)).toMatchObject({ status: 'session_transferred', ready: false });
    expect(constructed.saved.at(-1).lastDisconnectReason).toMatch(/reclaim/);
  });
});

// Grafo de imports (estáticos e dinâmicos) a partir de um arquivo, só dentro do repositório.
function importGraph(entry) {
  const seen = new Set();
  const external = new Set();
  const stack = [entry];
  const re = /(?:import\s[^'"]*?from\s*|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(re)) {
      const spec = m[1];
      if (spec.startsWith('.')) {
        let p = path.resolve(path.dirname(file), spec);
        if (!fs.existsSync(p) && fs.existsSync(`${p}.js`)) p = `${p}.js`;
        if (fs.existsSync(p) && fs.statSync(p).isFile()) stack.push(p);
      } else {
        external.add(spec.split('/')[0].startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
      }
    }
  }
  return { files: [...seen].map((f) => path.relative(ROOT, f)), external: [...external] };
}

describe('separação CRM × conector', () => {
  it('a ponte do worker não alcança whatsapp-web.js, puppeteer nem o whatsappWebJsService', () => {
    const g = importGraph(path.join(ROOT, 'workers/whatsappConnectorBridge.js'));
    expect(g.files).not.toContain('services/whatsappWebJsService.js');
    for (const pkg of ['whatsapp-web.js', 'puppeteer', 'puppeteer-core', 'wwebjs-mongo']) expect(g.external).not.toContain(pkg);
  });

  it('o conector (whatsapp-connector/) não importa nada do CRM, e o CRM não importa o conector em produção', () => {
    const connRoot = path.join(ROOT, 'whatsapp-connector');
    for (const entry of ['src/index.js', 'scripts/import-session.js']) {
      const g = importGraph(path.join(connRoot, entry));
      for (const f of g.files) expect(f.startsWith('whatsapp-connector/')).toBe(true);
      for (const pkg of g.external) expect(['whatsapp-web.js', 'qrcode', 'fs', 'os', 'path', 'http', 'crypto', 'child_process', 'net', 'url']).toContain(pkg);
    }
    const prodEntries = ['server.js', 'workers/entrypoints/whatsapp-only.js', 'workers/whatsappConnectorBridge.js'];
    for (const e of prodEntries) expect(importGraph(path.join(ROOT, e)).files.some((f) => f.startsWith('whatsapp-connector/'))).toBe(false);
  });

  it('contrato: a cópia do conector é idêntica ao original do CRM (abaixo do cabeçalho)', () => {
    const body = (f) => { const s = fs.readFileSync(path.join(ROOT, f), 'utf8'); return s.slice(s.indexOf('// Autenticação')); };
    expect(body('whatsapp-connector/src/contract.js')).toBe(body('services/whatsappConnector/contract.js'));
  });
});
