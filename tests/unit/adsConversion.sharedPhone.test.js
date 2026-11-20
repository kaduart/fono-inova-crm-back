/** Correção 3: telefone usado por mais de um paciente (lógica pura). */
import { describe, it, expect } from 'vitest';
import { decidePlatforms, withoutClickIds, attributionEvidenceOf, sharedPhoneGuardEnabled } from '../../crons/adsConversion.logic.js';

const now = Date.parse('2026-11-20T12:00:00Z');
const args = { first: true, phone: '5562999990004', attr: { source: 'google_ads', method: 'site_signature', gclid: 'GCLID-FICTICIO-MAE', ttclid: 'TT', ctwaClid: 'CL' }, eventTimeMs: now - 3600e3, now };

describe('withoutClickIds', () => {
  it('irmão do mesmo telefone: nenhuma linha com gclid, Google pulado com motivo', () => {
    const normal = decidePlatforms(args);
    expect(normal.gclid).toBe('GCLID-FICTICIO-MAE');
    const d = withoutClickIds(args);
    expect(d).toMatchObject({ gclid: null, fbc: null, ttclid: null, ctwaClid: null, isAcquisition: true });
    expect(d.google).toEqual({ status: 'skipped', reason: 'telefone_compartilhado' });
    // Meta e TikTok seguem pelo telefone (não dependem do clique)
    expect(d.meta.status).toBe('pending');
    expect(d.tiktok.status).toBe('pending');
  });

  it('sem telefone e sem clique: tudo pulado com o motivo do compartilhamento', () => {
    const d = withoutClickIds({ ...args, phone: null });
    expect(d.meta).toEqual({ status: 'skipped', reason: 'telefone_compartilhado' });
    expect(d.tiktok).toEqual({ status: 'skipped', reason: 'telefone_compartilhado' });
    expect(d.done).toBe(true);
  });
});

describe('attributionEvidenceOf', () => {
  it('mesmo critério da receita', () => {
    expect(attributionEvidenceOf({ source: 'google_ads', gclid: 'G' })).toBe('comprovada');
    expect(attributionEvidenceOf({ source: 'google_ads', gclid: 'G', shared: true })).toBe('provavel');
    expect(attributionEvidenceOf({ source: 'meta_ads', method: 'ctwa' })).toBe('comprovada');
    expect(attributionEvidenceOf({ source: 'instagram', method: 'keyword' })).toBe('provavel');
    expect(attributionEvidenceOf({ source: 'unknown' })).toBe('sem_vinculo');
  });
});

describe('sharedPhoneGuardEnabled', () => {
  it('desligado por padrão', () => {
    expect(sharedPhoneGuardEnabled({})).toBe(false);
    expect(sharedPhoneGuardEnabled({ ADS_SHARED_PHONE_GUARD: 'on' })).toBe(true);
  });
});
