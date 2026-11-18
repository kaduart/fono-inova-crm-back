/**
 * 18/11/2026: ctwa_clid como identificador da Meta (business_messaging/whatsapp), reabertura
 * dos pulados e motivo de "Não identificado".
 */
import { describe, it, expect } from 'vitest';
import {
  decidePlatforms, metaSendOptions, shouldReopenMetaForClid, unknownReasonFor,
} from '../../crons/adsConversion.logic.js';

const now = Date.now();
const fresh = now - 3600e3;
const old = now - 10 * 864e5;

describe('decidePlatforms com ctwa_clid', () => {
  it('sem telefone mas com clid: Meta fica pendente', () => {
    const d = decidePlatforms({ first: true, phone: null, attr: { ctwaClid: 'ARAclid1234567' }, eventTimeMs: fresh, now });
    expect(d.meta.status).toBe('pending');
    expect(d.ctwaClid).toBe('ARAclid1234567');
  });
  it('sem telefone e sem clid: continua sem_telefone', () => {
    expect(decidePlatforms({ first: true, phone: null, attr: {}, eventTimeMs: fresh, now }).meta.reason).toBe('sem_telefone');
  });
  it('não é aquisição: nunca leva clid', () => {
    const d = decidePlatforms({ first: false, phone: '5562999999999', attr: { ctwaClid: 'ARAclid1234567' } });
    expect(d.ctwaClid).toBeNull();
    expect(d.meta.reason).toBe('nao_e_primeiro_agendamento');
  });
});

describe('metaSendOptions', () => {
  it('com clid: business_messaging + whatsapp', () => {
    expect(metaSendOptions({ ctwaClid: 'ARAclid1234567' })).toEqual({ actionSource: 'business_messaging', messagingChannel: 'whatsapp', ctwaClid: 'ARAclid1234567' });
  });
  it('sem clid: website como antes', () => {
    expect(metaSendOptions({})).toEqual({ actionSource: 'website', messagingChannel: null, ctwaClid: null });
  });
});

describe('shouldReopenMetaForClid', () => {
  const base = { isAcquisition: true, meta: { status: 'skipped', reason: 'sem_telefone' }, eventTime: new Date(fresh) };
  it('reabre pulado por falta de identificador dentro de 7 dias', () => expect(shouldReopenMetaForClid(base, now)).toBe(true));
  it('não reabre o que já foi aceito', () => expect(shouldReopenMetaForClid({ ...base, meta: { status: 'sent' } }, now)).toBe(false));
  it('não reabre fora da janela', () => expect(shouldReopenMetaForClid({ ...base, eventTime: new Date(old) }, now)).toBe(false));
  it('não reabre retorno de paciente', () => expect(shouldReopenMetaForClid({ ...base, isAcquisition: false }, now)).toBe(false));
  it('não reabre outro motivo de pulo', () => expect(shouldReopenMetaForClid({ ...base, meta: { status: 'skipped', reason: 'nao_e_primeiro_agendamento' } }, now)).toBe(false));
});

describe('unknownReasonFor', () => {
  it('com origem: sem motivo', () => expect(unknownReasonFor({ phone: '55', attr: { source: 'meta_ads' } })).toBeNull());
  it('sem telefone', () => expect(unknownReasonFor({ phone: null, attr: null })).toBe('sem_telefone'));
  it('com telefone e sem registro de origem', () => expect(unknownReasonFor({ phone: '5562999999999', attr: null })).toBe('sem_origem_capturada'));
  it('Lead existe mas sem origem (Agenda Direta)', () => expect(unknownReasonFor({ phone: '5562999999999', attr: { source: null, leadId: 'x' } })).toBe('lead_sem_origem'));
});
