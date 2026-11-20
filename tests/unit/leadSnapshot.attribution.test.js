/** Correção 1: origem gravada no agendamento (snapshot do lead lê metaTracking). */
import { describe, it, expect } from 'vitest';
import { snapshotFromLead } from '../../services/appointment/helpers/leadHelper.js';

describe('snapshotFromLead', () => {
  it('lead de anúncio: origem, campanha e identificadores vêm de metaTracking', () => {
    const s = snapshotFromLead({ origin: 'WhatsApp', createdAt: new Date('2026-11-01T10:00:00Z'),
      metaTracking: { source: 'google_ads', campaign: 'gg-fono-infantil', gclid: 'GCLID-FICTICIO', adId: null, ctwaClid: null } });
    expect(s).toMatchObject({ source: 'google_ads', campaign: 'gg-fono-infantil', origin: 'WhatsApp', gclid: 'GCLID-FICTICIO', adId: null, ctwaClid: null });
  });

  it('lead "Agenda Direta" sem metaTracking: cai na origem, sem campanha', () => {
    expect(snapshotFromLead({ origin: 'Agenda Direta' })).toMatchObject({ source: 'Agenda Direta', campaign: null, gclid: null });
  });

  it('metaTracking.source vazio não apaga a origem', () => {
    expect(snapshotFromLead({ origin: 'Indicação', metaTracking: { source: '' } }).source).toBe('Indicação');
  });
});

import { touchOf, MAX_TOUCHES } from '../../services/leadAttributionService.js';

describe('touchOf (correção 7)', () => {
  it('guarda só origem, método, confiança, campanha e se teve clique', () => {
    const at = new Date('2026-11-20T12:00:00Z');
    expect(touchOf({ source: 'google_ads', method: 'site_signature', confidence: 'high', campaign: 'gg', gclid: 'G-1', utmSource: 'x' }, at))
      .toEqual({ at, source: 'google_ads', method: 'site_signature', confidence: 'high', campaign: 'gg', temClique: true });
    expect(touchOf({ source: 'instagram', method: 'keyword' }, at).temClique).toBe(false);
    expect(MAX_TOUCHES).toBe(20);
  });
});
