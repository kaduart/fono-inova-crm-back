/**
 * Modo externo (WHATSAPP_CONNECTOR_MODE=external): o CRM nunca sobe Chrome — nem no boot, nem em
 * reconexão, recuperação ou retry. E a ponte do worker não importa nada de navegador.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';

const constructed = vi.hoisted(() => ({ n: 0 }));
vi.mock('whatsapp-web.js', () => {
  class Client { constructor() { constructed.n++; } on() {} initialize() { return new Promise(() => {}); } destroy() {} }
  return { default: { Client, LocalAuth: class {}, Poll: class {} } };
});
vi.mock('wwebjs-mongo', () => ({ MongoStore: class {} }));
vi.mock('qrcode', () => ({ default: { toDataURL: async () => '' } }));
vi.mock('../../models/WhatsAppWebState.js', () => ({
  default: { findOneAndUpdate: vi.fn().mockResolvedValue({}), findOne: () => ({ select: () => ({ lean: async () => null }), lean: async () => null }) },
}));
vi.mock('../../services/setPuppeteerCache.js', () => ({}));

const ROOT = path.resolve(__dirname, '../..');

describe('modo externo: Chrome proibido no CRM', () => {
  const prev = { mode: process.env.WHATSAPP_CONNECTOR_MODE, role: process.env.WA_ENGINE_ROLE };
  let svc;
  beforeAll(async () => {
    process.env.WHATSAPP_CONNECTOR_MODE = 'external';
    delete process.env.WA_ENGINE_ROLE;
    svc = await import('../../services/whatsappWebJsService.js');
  });
  afterAll(() => {
    if (prev.mode === undefined) delete process.env.WHATSAPP_CONNECTOR_MODE; else process.env.WHATSAPP_CONNECTOR_MODE = prev.mode;
    if (prev.role !== undefined) process.env.WA_ENGINE_ROLE = prev.role;
  });

  it('localChromeForbidden: externo sem papel de conector → proibido; conector → permitido', () => {
    expect(svc.localChromeForbidden({ WHATSAPP_CONNECTOR_MODE: 'external' })).toBe(true);
    expect(svc.localChromeForbidden({ WHATSAPP_CONNECTOR_MODE: 'external', WA_ENGINE_ROLE: 'connector' })).toBe(false);
    expect(svc.localChromeForbidden({})).toBe(false);
  });

  it('boot, reconexão manual e soft reconnect não criam o Client (Chrome)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await svc.initWhatsAppClient();
    await svc.reconnect().catch(() => {});
    await svc.softReconnect().catch(() => {});
    await svc.initWhatsAppClient();
    expect(constructed.n).toBe(0);
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

describe('ponte do worker não carrega navegador', () => {
  it('workers/whatsappConnectorBridge.js não alcança whatsapp-web.js, puppeteer nem o whatsappWebJsService', () => {
    const g = importGraph(path.join(ROOT, 'workers/whatsappConnectorBridge.js'));
    expect(g.files).not.toContain('services/whatsappWebJsService.js');
    for (const pkg of ['whatsapp-web.js', 'puppeteer', 'puppeteer-core', 'wwebjs-mongo']) expect(g.external).not.toContain(pkg);
  });
});
