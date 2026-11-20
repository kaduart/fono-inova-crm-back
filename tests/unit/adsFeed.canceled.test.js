/** Correção 4: cancelados no google-offline.csv (padrão ligado; ADS_FEED_SKIP_CANCELED=off desliga). */
import { describe, it, expect } from 'vitest';
import { feedRows, skipCanceledEnabled } from '../../routes/adsFeed.js';

const served = new Date('2026-11-10T00:00:00Z');
const rows = [
  { appointment: 'a1', gclid: 'G1' },                                 // ativo, ainda não saiu
  { appointment: 'a2', gclid: 'G2' },                                 // cancelado ANTES da 1ª entrega
  { appointment: 'a3', gclid: 'G3', googleCsvFirstServedAt: served }, // cancelado DEPOIS da 1ª entrega
  { appointment: 'a4', gclid: 'G4', googleCsvFirstServedAt: served }, // ativo, já saiu
];
const canceled = new Set(['a2', 'a3']);

describe('chave', () => {
  it('padrão (sem variável) = ligado; só "off" desliga', () => {
    expect(skipCanceledEnabled({})).toBe(true);
    expect(skipCanceledEnabled({ ADS_FEED_SKIP_CANCELED: 'on' })).toBe(true);
    expect(skipCanceledEnabled({ ADS_FEED_SKIP_CANCELED: 'OFF' })).toBe(false);
  });
});

describe('feedRows', () => {
  it('cancelado ANTES da 1ª entrega não sai', () => {
    expect(feedRows(rows, canceled, true).map((r) => r.appointment)).not.toContain('a2');
  });
  it('cancelado DEPOIS da 1ª entrega continua (o Google pode já ter importado)', () => {
    expect(feedRows(rows, canceled, true).map((r) => r.appointment)).toContain('a3');
  });
  it('ativos saem normalmente', () => {
    expect(feedRows(rows, canceled, true).map((r) => r.appointment)).toEqual(['a1', 'a3', 'a4']);
  });
  it('desligado (off): regra antiga, cancelado continua', () => {
    expect(feedRows(rows, canceled, false)).toHaveLength(4);
  });
});
