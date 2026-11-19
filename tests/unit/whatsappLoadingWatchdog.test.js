/**
 * 19/11/2026: loading_screen depois do ready rearmava o watchdog de 10 min e o child saía (exit 2)
 * a cada 10 min — recarga + catch-up + pico de memória + OOM no Render.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('../../models/WhatsAppWebState.js', () => ({ default: { findOneAndUpdate: vi.fn() } }));
const { shouldArmLoadingWatchdog } = await import('../../services/whatsappWebJsService.js');

describe('watchdog do loading_screen', () => {
  it('antes do ready: arma (travamento real na carga)', () => {
    expect(shouldArmLoadingWatchdog(false)).toBe(true);
  });
  it('depois do ready: não arma (sincronização normal do WhatsApp Web)', () => {
    expect(shouldArmLoadingWatchdog(true)).toBe(false);
  });
  it('o handler consulta a regra antes de armar o timer', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../services/whatsappWebJsService.js'), 'utf8');
    const handler = src.slice(src.indexOf("newClient.on('loading_screen'"), src.indexOf("newClient.on('disconnected'"));
    expect(handler.indexOf('shouldArmLoadingWatchdog(isReady)')).toBeGreaterThan(-1);
    expect(handler.indexOf('shouldArmLoadingWatchdog(isReady)')).toBeLessThan(handler.indexOf('loadingWatchdog = setTimeout'));
  });
});
