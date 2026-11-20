/** Correção 4: cancelados no google-offline.csv (atrás de ADS_FEED_SKIP_CANCELED, desligada). */
import { describe, it, expect } from 'vitest';
import { feedRows, skipCanceledEnabled } from '../../routes/adsFeed.js';

const rows = [
  { appointment: 'a1', gclid: 'G1' },
  { appointment: 'a2', gclid: 'G2' },
  { appointment: 'a3', gclid: 'G3', googleCsvFirstServedAt: new Date('2026-11-10T00:00:00Z') },
];
const canceled = new Set(['a2', 'a3']);

describe('feedRows', () => {
  it('desligado: regra atual, cancelado continua', () => {
    expect(feedRows(rows, canceled, false)).toHaveLength(3);
    expect(skipCanceledEnabled({})).toBe(false);
  });
  it('ligado: cancelado antes de sair não sai; o que já saiu continua', () => {
    expect(feedRows(rows, canceled, true).map((r) => r.appointment)).toEqual(['a1', 'a3']);
    expect(skipCanceledEnabled({ ADS_FEED_SKIP_CANCELED: 'on' })).toBe(true);
  });
});
