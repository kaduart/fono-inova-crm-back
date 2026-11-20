/**
 * Frente 2 — receita RECEBIDA por campanha (núcleo puro, dados fictícios).
 * Casos: pagamento parcial de pacote, estorno total, telefone compartilhado (irmãos),
 * convênio, linha "sem vínculo", contato da campanha DEPOIS do recebimento, estorno que
 * desfaz o recebimento original e invariante soma dos níveis == líquido do ledger.
 */
import { describe, it, expect } from 'vitest';
import { attributeReceivedRevenue, classifyLedgerEntry, phoneFormatsOf } from '../../services/attribution/revenueAttribution.js';
import { amostra, ESPERADO, P, PHONES, ledgerEntries, adConversions } from '../../services/attribution/fixtures/receitaFicticia.js';

const linha = (r, nivel, origem) => r.linhas.filter((l) => l.nivel === nivel && l.origem === origem);

describe('attributeReceivedRevenue — amostra fictícia da auditoria', () => {
  const r = attributeReceivedRevenue(amostra);

  it('fecha com o líquido do ledger: 480 + 570 + 240 = 1.290', () => {
    expect(r.totalLiquidoLedger).toBe(ESPERADO.total);
    expect(r.porNivel).toEqual({ comprovada: 480, provavel: 570, sem_vinculo: 240 });
    expect(r.invariante).toEqual({ somaNiveis: 1290, totalLiquidoLedger: 1290, fecha: true });
    const somaLinhas = r.linhas.reduce((s, l) => s + l.liquido, 0) + r.semVinculo.liquido;
    expect(somaLinhas).toBe(1290);
  });

  it('diverge do painel antigo (soma de AdConversion.value = 2.040)', () => {
    const painelAntigo = adConversions.reduce((s, c) => s + c.value, 0);
    expect(painelAntigo).toBe(ESPERADO.painelAntigo);
    expect(r.totalLiquidoLedger).not.toBe(painelAntigo);
  });

  it('pagamento parcial: pacote de R$ 600 com R$ 200 pago contribui R$ 200 (consumo de sessão fora)', () => {
    const meta = linha(r, 'comprovada', 'meta_ads').find((l) => l.adId === 'AD-FICTICIO-1');
    expect(meta).toMatchObject({ adId: 'AD-FICTICIO-1', recebido: 200, liquido: 200, pacientes: 1 });
    expect(r.excluidos.package_consumed).toEqual({ lancamentos: 1, valor: 150 });
  });

  it('estorno total: TikTok recebeu 180 e estornou 180 → líquido 0', () => {
    const [tt] = linha(r, 'comprovada', 'tiktok_ads');
    expect(tt).toMatchObject({ recebido: 180, estornos: 180, liquido: 0, lancamentos: 2 });
  });

  it('telefone compartilhado: irmã que veio por indicação NÃO vira Google comprovada', () => {
    const googleComprovada = linha(r, 'comprovada', 'google_ads');
    expect(googleComprovada).toHaveLength(1);
    expect(googleComprovada[0]).toMatchObject({ liquido: 120, pacientes: 1 }); // só a Ana
    const [googleProvavel] = linha(r, 'provavel', 'google_ads');
    expect(googleProvavel).toMatchObject({ liquido: 470, pacientes: 3 }); // Davi 200 + Eva 140 + Iris 130
    expect(googleProvavel.motivosPorLancamento).toEqual({ sinal_forte_em_telefone_compartilhado: 3 });
  });

  it('Hugo: só o recebimento DEPOIS do anúncio vai para a campanha', () => {
    const [hugo] = linha(r, 'comprovada', 'meta_ads').filter((l) => l.adId === 'AD-FICTICIO-2');
    expect(hugo).toMatchObject({ recebido: 160, liquido: 160, lancamentos: 1 });
    expect(r.semVinculo.motivos.contato_da_campanha_depois_do_recebimento).toBe(90);
  });

  it('convênio: conta insurance_received (100), não insurance_billed (200); palavra-chave = provável', () => {
    const [ig] = linha(r, 'provavel', 'instagram');
    expect(ig).toMatchObject({ liquido: 100, motivosPorLancamento: { so_sinal_fraco: 1 } });
    expect(r.excluidos.insurance_billed).toEqual({ lancamentos: 1, valor: 200 });
  });

  it('origem desconhecida fica numa linha própria, com o motivo', () => {
    expect(r.semVinculo).toMatchObject({
      liquido: 240, recebido: 240, pacientes: 2,
      motivos: { sem_origem_capturada: 150, contato_da_campanha_depois_do_recebimento: 90 },
    });
    expect(r.linhas.some((l) => l.origem === 'unknown')).toBe(false);
  });

  it('reconhecimento contábil e reversão de sessão sem pagamento ficam fora', () => {
    expect(r.excluidos.revenue_recognition).toEqual({ lancamentos: 1, valor: 120 });
    expect(r.excluidos.reversal_sem_vinculo_de_caixa).toEqual({ lancamentos: 1, valor: 80 });
  });
});

describe('classifyLedgerEntry', () => {
  it('sinal vem da direção, e débitos só contam vinculados a pagamento', () => {
    expect(classifyLedgerEntry({ type: 'payment_received', direction: 'credit', amount: 10.1 })).toEqual({ counted: true, signedCents: 1010 });
    expect(classifyLedgerEntry({ type: 'reversal', direction: 'debit', amount: 5, reversalOfEntryId: 'x' })).toEqual({ counted: true, signedCents: -500 });
    expect(classifyLedgerEntry({ type: 'refund', direction: 'debit', amount: 5 }).counted).toBe(false);
    expect(classifyLedgerEntry({ type: 'payment_pending', direction: 'credit', amount: 5 })).toEqual({ counted: false, reason: 'payment_pending' });
  });
});

describe('casos de borda', () => {
  it('reversão de crédito fora do período herda o paciente pelo reversalOfEntryId', () => {
    const r = attributeReceivedRevenue({
      ...amostra,
      ledgerEntries: [
        ...ledgerEntries,
        { _id: 'rev-1', type: 'reversal', direction: 'debit', amount: 50, payment: 'pay-antigo', reversalOfEntryId: 'cred-antigo' },
      ],
      referenceEntries: [{ _id: 'cred-antigo', type: 'payment_received', patient: P.ana, payment: 'pay-antigo', occurredAt: new Date('2026-11-06T15:00:00Z') }],
    });
    expect(r.totalLiquidoLedger).toBe(1240);
    expect(r.porNivel.comprovada).toBe(430);
    expect(r.invariante.fecha).toBe(true);
  });

  it('lançamento de caixa sem paciente vai para sem vínculo (lancamento_sem_paciente)', () => {
    const r = attributeReceivedRevenue({ ledgerEntries: [{ _id: 'x', type: 'payment_received', direction: 'credit', amount: 33.33 }] });
    expect(r.semVinculo.motivos).toEqual({ lancamento_sem_paciente: 33.33 });
    expect(r.invariante.fecha).toBe(true);
  });

  it('LeadAttribution com click id em telefone exclusivo (sem AdConversion) = comprovada', () => {
    const r = attributeReceivedRevenue({
      ledgerEntries: [{ _id: 'x', type: 'payment_received', direction: 'credit', amount: 90, patient: 'p1', payment: 'y', occurredAt: new Date('2026-11-10T15:00:00Z') }],
      patients: [{ _id: 'p1', phone: PHONES.fabio }],
      leadAttributions: [{ phone: PHONES.fabio, source: 'google_ads', method: 'keyword', gclid: 'G-FICT', firstMessageAt: new Date('2026-11-01T12:00:00Z') }],
    });
    expect(r.porNivel.comprovada).toBe(90);
  });

  it('centavos não acumulam erro de ponto flutuante', () => {
    const ledger = Array.from({ length: 10 }, (_, i) => ({ _id: `c${i}`, type: 'payment_received', direction: 'credit', amount: 0.1, patient: 'p' }));
    const r = attributeReceivedRevenue({ ledgerEntries: ledger });
    expect(r.totalLiquidoLedger).toBe(1);
    expect(r.invariante.fecha).toBe(true);
  });
});

// ── Revisão do PR #100: contato da campanha só vale até a data do recebimento ──
const d = (s) => new Date(s);
const pay = (_id, amount, occurredAt, extra = {}) => ({ _id, type: 'payment_received', direction: 'credit', amount, patient: 'px', payment: `pay-${_id}`, occurredAt: d(occurredAt), ...extra });
const campanhaNovembro = { _id: 'conv-px', patient: 'px', phone: '5562988880001', isAcquisition: true, source: 'meta_ads', attributionMethod: 'ctwa', adId: 'AD-NOV', ctwaClid: 'CLID-NOV', eventTime: d('2026-11-05T13:00:00Z') };
const pacientePx = [{ _id: 'px', phone: '5562988880001' }];

describe('campanha que chegou DEPOIS do recebimento', () => {
  it('pagou em outubro, chegou pela campanha em novembro e pagou de novo: só o 2º vai para a campanha', () => {
    const r = attributeReceivedRevenue({
      ledgerEntries: [pay('out', 100, '2026-10-15T15:00:00Z'), pay('nov', 250, '2026-11-10T15:00:00Z')],
      adConversions: [campanhaNovembro],
      patients: pacientePx,
    });
    expect(r.linhas).toEqual([expect.objectContaining({ nivel: 'comprovada', origem: 'meta_ads', adId: 'AD-NOV', recebido: 250, liquido: 250, lancamentos: 1 })]);
    expect(r.semVinculo).toMatchObject({ liquido: 100, motivos: { contato_da_campanha_depois_do_recebimento: 100 } });
    expect(r.porNivel).toEqual({ comprovada: 250, provavel: 0, sem_vinculo: 100 });
    expect(r.invariante.fecha).toBe(true);
  });

  it('com uma origem ANTERIOR (LeadAttribution de setembro), o recebimento de outubro vai para ela', () => {
    const r = attributeReceivedRevenue({
      ledgerEntries: [pay('out', 100, '2026-10-15T15:00:00Z'), pay('nov', 250, '2026-11-10T15:00:00Z')],
      adConversions: [campanhaNovembro],
      leadAttributions: [{ phone: '556288880001', source: 'instagram', method: 'keyword', firstMessageAt: d('2026-09-20T12:00:00Z') }],
      patients: pacientePx,
    });
    expect(r.linhas.find((l) => l.origem === 'instagram')).toMatchObject({ nivel: 'provavel', liquido: 100 });
    expect(r.linhas.find((l) => l.origem === 'meta_ads')).toMatchObject({ nivel: 'comprovada', liquido: 250 });
    expect(r.semVinculo.liquido).toBe(0);
  });

  it('o firstMessageAt da LeadAttribution com a MESMA origem antecipa a data do contato', () => {
    const r = attributeReceivedRevenue({
      ledgerEntries: [pay('out', 100, '2026-10-15T15:00:00Z')],
      adConversions: [campanhaNovembro],
      leadAttributions: [{ phone: '5562988880001', source: 'meta_ads', method: 'ctwa', adId: 'AD-NOV', firstMessageAt: d('2026-10-01T12:00:00Z') }],
      patients: pacientePx,
    });
    expect(r.porNivel.comprovada).toBe(100);
  });

  it('origem sem data de contato não prova nada', () => {
    const r = attributeReceivedRevenue({
      ledgerEntries: [pay('nov', 50, '2026-11-10T15:00:00Z')],
      adConversions: [{ ...campanhaNovembro, eventTime: null }],
      patients: pacientePx,
    });
    expect(r.semVinculo.motivos).toEqual({ origem_sem_data_de_contato: 50 });
  });
});

describe('estorno desfaz o recebimento ORIGINAL', () => {
  it('estorno em novembro de um pagamento de outubro (antes da campanha) sai do sem vínculo, não da campanha', () => {
    const r = attributeReceivedRevenue({
      ledgerEntries: [
        pay('nov', 250, '2026-11-10T15:00:00Z'),
        { _id: 'est', type: 'refund', direction: 'debit', amount: 100, patient: 'px', payment: 'pay-out', occurredAt: d('2026-11-12T15:00:00Z') },
      ],
      referenceEntries: [pay('out', 100, '2026-10-15T15:00:00Z')],
      adConversions: [campanhaNovembro],
      patients: pacientePx,
    });
    expect(r.linhas.find((l) => l.origem === 'meta_ads')).toMatchObject({ recebido: 250, estornos: 0, liquido: 250 });
    expect(r.semVinculo).toMatchObject({ estornos: 100, liquido: -100, motivos: { contato_da_campanha_depois_do_recebimento: -100 } });
    expect(r.porNivel).toEqual({ comprovada: 250, provavel: 0, sem_vinculo: -100 });
    expect(r.invariante.fecha).toBe(true);
  });

  it('reversão (reversalOfEntryId) de um recebimento da campanha tira da MESMA campanha e nível', () => {
    const r = attributeReceivedRevenue({
      ledgerEntries: [
        pay('nov', 250, '2026-11-10T15:00:00Z'),
        { _id: 'rev', type: 'reversal', direction: 'debit', amount: 250, reversalOfEntryId: 'nov', occurredAt: d('2026-11-15T15:00:00Z') },
      ],
      adConversions: [campanhaNovembro],
      patients: pacientePx,
    });
    expect(r.linhas).toEqual([expect.objectContaining({ nivel: 'comprovada', adId: 'AD-NOV', recebido: 250, estornos: 250, liquido: 0, lancamentos: 2 })]);
    expect(r.invariante.fecha).toBe(true);
  });

  it('estorno sem recebimento original encontrado vai para sem vínculo com o motivo', () => {
    const r = attributeReceivedRevenue({
      ledgerEntries: [{ _id: 'est', type: 'refund', direction: 'debit', amount: 40, patient: 'px', payment: 'pay-sumiu', occurredAt: d('2026-11-12T15:00:00Z') }],
      adConversions: [campanhaNovembro],
      patients: pacientePx,
    });
    expect(r.semVinculo.motivos).toEqual({ estorno_sem_recebimento_original: -40 });
  });
});

describe('telefone compartilhado com grafias diferentes', () => {
  it('irmão sem lançamento, com outra grafia do mesmo número, deixa quem pagou em "provável"', () => {
    const base = {
      ledgerEntries: [pay('nov', 130, '2026-11-10T15:00:00Z')],
      adConversions: [{ ...campanhaNovembro, phone: '5562988880001', source: 'google_ads', attributionMethod: 'site_signature', gclid: 'G-FICT', adId: null, ctwaClid: null, campaign: 'gg' }],
    };
    for (const grafia of ['(62) 98888-0001', '62988880001', '+55 62 98888-0001', '(62) 8888-0001']) {
      const r = attributeReceivedRevenue({ ...base, patients: [{ _id: 'px', phone: '5562988880001' }, { _id: 'irmao', phone: grafia }] });
      expect(r.porNivel, grafia).toEqual({ comprovada: 0, provavel: 130, sem_vinculo: 0 });
    }
    const sozinho = attributeReceivedRevenue({ ...base, patients: [{ _id: 'px', phone: '5562988880001' }] });
    expect(sozinho.porNivel.comprovada).toBe(130);
  });
});

describe('phoneFormatsOf', () => {
  it('cobre as grafias com máscara, com 55/+55 e com/sem o 9', () => {
    const f = phoneFormatsOf('(62) 99999-0000');
    for (const g of ['(62) 99999-0000', '62999990000', '+55 62 99999-0000', '5562999990000', '+5562999990000', '+55 (62) 99999-0000', '(62) 9999-0000', '6299990000']) {
      expect(f, g).toContain(g);
    }
    expect(phoneFormatsOf('+55 62 99999-0000').sort()).toEqual(phoneFormatsOf('62999990000').sort());
  });
});
