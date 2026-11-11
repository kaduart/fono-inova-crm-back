import { describe, it, expect } from 'vitest';
import { resolveConversionAction, uploadOfflineConversion } from '../../services/googleAdsConversionsService.js';

const env = { GOOGLE_ADS_CONVERSION_ACTION_ID: '111', GOOGLE_ADS_EVAL_DONE_ACTION_ID: '222' };

describe('Google Ads: ação de conversão separada (sem contar em dobro)', () => {
  it('agendamento vai para "Avaliação agendada"', () => {
    expect(resolveConversionAction({ orderId: 'appt_abc' }, env)).toMatchObject({ kind: 'scheduled', actionId: '111' });
  });

  it('avaliação concluída (order_id aval-) vai para "Avaliação realizada", nunca para a agendada', () => {
    expect(resolveConversionAction({ orderId: 'aval-abc' }, env)).toMatchObject({ kind: 'evaluation_done', actionId: '222' });
    expect(resolveConversionAction({ orderId: 'aval-abc', kind: 'scheduled' }, env).actionId).toBe('222');
  });

  it('sem GOOGLE_ADS_EVAL_DONE_ACTION_ID a avaliação concluída fica desligada', () => {
    const r = resolveConversionAction({ kind: 'evaluation_done' }, { GOOGLE_ADS_CONVERSION_ACTION_ID: '111' });
    expect(r.actionId).toBeNull();
  });

  it('upload da avaliação concluída sem o env retorna skipped (não cai na ação agendada)', async () => {
    const prev = { ...process.env };
    process.env.GOOGLE_ADS_CONVERSION_ACTION_ID = '111';
    delete process.env.GOOGLE_ADS_EVAL_DONE_ACTION_ID;
    try {
      const r = await uploadOfflineConversion({ gclid: 'g', value: 220, orderId: 'aval-1' });
      expect(r.status).toBe('skipped');
      expect(r.reason).toMatch(/GOOGLE_ADS_EVAL_DONE_ACTION_ID/);
    } finally {
      process.env = prev;
    }
  });
});
