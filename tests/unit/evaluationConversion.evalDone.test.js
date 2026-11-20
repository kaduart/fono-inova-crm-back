/** Correção 5: estado da "Avaliação realizada" gravado em AdConversion.evalDone (gclid só lá dentro). */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const appts = new Map();
const updates = [];
vi.mock('../../models/Appointment.js', () => ({
  default: { findById: (id) => ({ select: () => ({ lean: async () => appts.get(String(id)) || null }) }) },
}));
vi.mock('../../models/AdConversion.js', () => ({
  default: { updateOne: async (filter, update) => { updates.push({ filter, update }); return { modifiedCount: 1 }; } },
}));
vi.mock('../../services/leadAttributionService.js', () => ({ getAttributionByPhone: async () => null }));
vi.mock('../../services/googleAdsConversionsService.js', () => ({ uploadOfflineConversion: async () => ({ status: 'sent' }) }));

const { reportEvaluationConversion } = await import('../../services/appointment/evaluationConversion.service.js');

const deps = (over = {}) => ({
  resolvePhone: async (a) => a.patientInfo?.phone || null,
  withGclidFallback: async ({ attr }) => attr,
  getAttributionByPhone: async () => null,
  uploadOfflineConversion: async () => ({ status: 'sent' }),
  ...over,
});

beforeEach(() => {
  updates.length = 0;
  appts.clear();
  appts.set('ap1', { serviceType: 'evaluation', operationalStatus: 'completed', sessionValue: 220, date: new Date('2026-11-26T13:00:00Z'), patientInfo: { phone: '5562999990001' } });
});

describe('reportEvaluationConversion — evalDone', () => {
  it('sent: grava status e o gclid dentro do subdocumento', async () => {
    const r = await reportEvaluationConversion('ap1', deps({ getAttributionByPhone: async () => ({ gclid: 'GCLID-FICTICIO' }) }));
    expect(r.status).toBe('sent');
    const set = updates[0].update.$set;
    expect(updates[0].filter).toEqual({ appointment: 'ap1' });
    expect(Object.keys(set)).toEqual(['evalDone']);           // nada no topo (CSV intacto)
    expect(set.evalDone).toMatchObject({ status: 'sent', gclid: 'GCLID-FICTICIO' });
  });

  it('usa o fallback de gclid do cron', async () => {
    const r = await reportEvaluationConversion('ap1', deps({ withGclidFallback: async () => ({ gclid: 'GCLID-DO-LEAD' }) }));
    expect(r.status).toBe('sent');
    expect(updates[0].update.$set.evalDone.gclid).toBe('GCLID-DO-LEAD');
  });

  it('skipped sem gclid e sem telefone', async () => {
    expect((await reportEvaluationConversion('ap1', deps())).status).toBe('no_gclid');
    expect(updates[0].update.$set.evalDone).toMatchObject({ status: 'skipped', reason: 'sem_gclid' });
    appts.get('ap1').patientInfo = {};
    expect((await reportEvaluationConversion('ap1', deps())).status).toBe('no_phone');
    expect(updates[1].update.$set.evalDone).toMatchObject({ status: 'skipped', reason: 'sem_telefone' });
  });

  it('failed também é gravado', async () => {
    await reportEvaluationConversion('ap1', deps({ getAttributionByPhone: async () => ({ gclid: 'G' }), uploadOfflineConversion: async () => ({ status: 'failed', reason: 'EXPIRED_EVENT' }) }));
    expect(updates[0].update.$set.evalDone).toMatchObject({ status: 'failed', reason: 'EXPIRED_EVENT' });
  });

  it('não avaliação ou não concluída: não grava nada', async () => {
    appts.get('ap1').operationalStatus = 'scheduled';
    expect((await reportEvaluationConversion('ap1', deps())).status).toBe('not_completed');
    expect(updates).toHaveLength(0);
  });
});
