import { describe, it, expect, vi } from 'vitest';

vi.mock('whatsapp-web.js', () => ({ default: { Client: vi.fn(), LocalAuth: vi.fn() } }));
vi.mock('wwebjs-mongo', () => ({ MongoStore: vi.fn() }));
vi.mock('../../models/WhatsAppWebState.js', () => ({
  default: { findOneAndUpdate: vi.fn().mockResolvedValue({}), findOne: vi.fn().mockResolvedValue(null) },
}));
vi.mock('../../services/setPuppeteerCache.js', () => ({}));
vi.mock('puppeteer', () => ({ default: { executablePath: vi.fn(() => '/usr/bin/chrome') } }));
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn() } }));

const { chromeJsHeapArgs, getPageMemory } = await import('../../services/whatsappWebJsService.js');

describe('teto de heap JS da aba do WhatsApp (OOM do crm-worker)', () => {
  it('usa 1024 MB por padrão', () => {
    expect(chromeJsHeapArgs({})).toEqual(['--js-flags=--max-old-space-size=1024']);
    expect(chromeJsHeapArgs({ WHATSAPP_CHROME_JS_HEAP_MB: '' })).toEqual(['--js-flags=--max-old-space-size=1024']);
  });
  it('respeita o valor da env', () => {
    expect(chromeJsHeapArgs({ WHATSAPP_CHROME_JS_HEAP_MB: '900' })).toEqual(['--js-flags=--max-old-space-size=900']);
  });
  it('0 ou valor inválido desliga o teto', () => {
    expect(chromeJsHeapArgs({ WHATSAPP_CHROME_JS_HEAP_MB: '0' })).toEqual([]);
    expect(chromeJsHeapArgs({ WHATSAPP_CHROME_JS_HEAP_MB: 'abc' })).toEqual([]);
  });
  it('getPageMemory devolve null sem client e não lança', async () => {
    await expect(getPageMemory()).resolves.toBeNull();
  });
});
