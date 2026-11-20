/**
 * 19/11/2026: loading_screen depois do ready rearmava o watchdog de 10 min e o child saía (exit 2)
 * a cada 10 min — recarga + catch-up + pico de memória + OOM no Render.
 * Roda os handlers reais de createClient() com um Client falso e relógio falso:
 *   1) ready cancela um timer já armado;
 *   2) loading_screen depois do ready não rearma;
 *   3) travamento real antes do ready ainda dispara a recuperação (exit 2 em 10 min);
 *   4) (20/11) corrida: ready chega enquanto o loading_screen anterior espera o saveState.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.WHATSAPP_AUTH_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-wd-'));

vi.mock('whatsapp-web.js', async () => {
  const { EventEmitter: EE } = await import('events');
  class Client extends EE { constructor(opts) { super(); this.options = opts; } }
  class LocalAuth { constructor(o) { this.o = o; } }
  class Poll {}
  return { default: { Client, LocalAuth, Poll } };
});
vi.mock('wwebjs-mongo', () => ({ MongoStore: class {} }));
vi.mock('../../models/WhatsAppWebState.js', () => ({ default: { findOneAndUpdate: vi.fn(async () => null), findOne: vi.fn(async () => null) } }));

const svc = await import('../../services/whatsappWebJsService.js');
const WhatsAppWebState = (await import('../../models/WhatsAppWebState.js')).default;
const TEN_MIN = 10 * 60 * 1000;
const flush = () => new Promise((r) => setImmediate(r));

let exitSpy;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined);
});
afterEach(() => { vi.useRealTimers(); exitSpy.mockRestore(); });

async function emit(c, ev, ...args) {
  for (const l of c.listeners(ev)) { await l(...args); }
  await flush();
}

describe('watchdog do loading_screen (handlers reais)', () => {
  it('regra pura: arma só antes do ready', () => {
    expect(svc.shouldArmLoadingWatchdog(false)).toBe(true);
    expect(svc.shouldArmLoadingWatchdog(true)).toBe(false);
  });

  it('3) travamento real antes do ready: sai em 10 min para respawn', async () => {
    const c = svc.createClient();
    await emit(c, 'loading_screen', 30, 'WhatsApp');
    vi.advanceTimersByTime(TEN_MIN + 1000);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('1) ready cancela o timer já armado', async () => {
    const c = svc.createClient();
    await emit(c, 'loading_screen', 0, 'WhatsApp');
    await emit(c, 'ready');
    vi.advanceTimersByTime(TEN_MIN + 1000);
    expect(exitSpy).not.toHaveBeenCalledWith(2);
  });

  it('2) loading_screen depois do ready não rearma (o caso de produção 72/97/99%)', async () => {
    const c = svc.createClient();
    await emit(c, 'loading_screen', 0, 'WhatsApp');
    await emit(c, 'ready');
    await emit(c, 'loading_screen', 72, 'WhatsApp');
    await emit(c, 'loading_screen', 97, 'WhatsApp');
    await emit(c, 'loading_screen', 99, 'WhatsApp');
    vi.advanceTimersByTime(3 * TEN_MIN);
    expect(exitSpy).not.toHaveBeenCalledWith(2);
    expect(svc.whatsappState.ready).toBe(true);
  });

  it('4) corrida de produção: ready durante o saveState do loading_screen 67% não deixa timer armado', async () => {
    const c = svc.createClient();
    await emit(c, 'disconnected', 'teste'); // zera o estado de módulo (isReady) deixado pelos testes anteriores
    let releaseSave;
    WhatsAppWebState.findOneAndUpdate.mockImplementationOnce(() => new Promise((r) => { releaseSave = () => r(null); }));
    const [loadingHandler] = c.listeners('loading_screen');
    const pending = loadingHandler(67, 'WhatsApp');   // pausa no saveState (banco lento)
    await emit(c, 'ready');                            // ready chega no meio (~200 ms em produção)
    await emit(c, 'loading_screen', 99, 'WhatsApp');
    releaseSave();
    await pending;
    await flush();
    vi.advanceTimersByTime(3 * TEN_MIN);
    expect(exitSpy).not.toHaveBeenCalledWith(2);
  });
});
