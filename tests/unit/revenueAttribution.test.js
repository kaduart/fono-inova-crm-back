/**
 * Frente 2 — receita RECEBIDA por campanha (núcleo puro, dados fictícios).
 * Casos: pagamento parcial de pacote, estorno total, telefone compartilhado (irmãos),
 * convênio, linha "sem vínculo" e invariante soma dos níveis == líquido do ledger.
 */
import { describe, it, expect } from 'vitest';
import { attributeReceivedRevenue, classifyLedgerEntry } from '../../services/attribution/revenueAttribution.js';
import { amostra, ESPERADO, P, PHONES, ledgerEntries, adConversions } from '../../services/attribution/fixtures/receitaFicticia.js';

const linha = (r, nivel, origem) => r.linhas.filter((l) => l.nivel === nivel && l.origem === origem);

describe('attributeReceivedRevenue — amostra fictícia da auditoria', () => {
  const r = attributeReceivedRevenue(amostra);

  it('fecha com o líquido do ledger: 320 + 440 + 150 = 910', () => {
    expect(r.totalLiquidoLedger).toBe(ESPERADO.total);
    expect(r.porNivel).toEqual({ comprovada: ESPERADO.comprovada, provavel: ESPERADO.provavel, sem_vinculo: ESPERADO.sem_vinculo });
    expect(r.invariante).toEqual({ somaNiveis: 910, totalLiquidoLedger: 910, fecha: true });
    const somaLinhas = r.linhas.reduce((s, l) => s + l.liquido, 0) + r.semVinculo.liquido;
    expect(somaLinhas).toBe(910);
  });

  it('diverge do painel antigo (soma de AdConversion.value = 1.540)', () => {
    const painelAntigo = adConversions.reduce((s, c) => s + c.value, 0);
    expect(painelAntigo).toBe(ESPERADO.painelAntigo);
    expect(r.totalLiquidoLedger).not.toBe(painelAntigo);
  });

  it('pagamento parcial: pacote de R$ 600 com R$ 200 pago contribui R$ 200 (consumo de sessão fora)', () => {
    const [meta] = linha(r, 'comprovada', 'meta_ads');
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
    expect(googleProvavel).toMatchObject({ liquido: 340, pacientes: 2 }); // Davi 200 + Eva 140
    expect(googleProvavel.motivosPorLancamento).toEqual({ sinal_forte_em_telefone_compartilhado: 2 });
  });

  it('convênio: conta insurance_received (100), não insurance_billed (200); palavra-chave = provável', () => {
    const [ig] = linha(r, 'provavel', 'instagram');
    expect(ig).toMatchObject({ liquido: 100, motivosPorLancamento: { so_sinal_fraco: 1 } });
    expect(r.excluidos.insurance_billed).toEqual({ lancamentos: 1, valor: 200 });
  });

  it('origem desconhecida fica numa linha própria, com o motivo', () => {
    expect(r.semVinculo).toMatchObject({ liquido: 150, recebido: 150, pacientes: 1, motivos: { sem_origem_capturada: 150 } });
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
      referenceEntries: [{ _id: 'cred-antigo', type: 'payment_received', patient: P.ana, payment: 'pay-antigo' }],
    });
    expect(r.totalLiquidoLedger).toBe(860);
    expect(r.porNivel.comprovada).toBe(270);
    expect(r.invariante.fecha).toBe(true);
  });

  it('lançamento de caixa sem paciente vai para sem vínculo (lancamento_sem_paciente)', () => {
    const r = attributeReceivedRevenue({ ledgerEntries: [{ _id: 'x', type: 'payment_received', direction: 'credit', amount: 33.33 }] });
    expect(r.semVinculo.motivos).toEqual({ lancamento_sem_paciente: 33.33 });
    expect(r.invariante.fecha).toBe(true);
  });

  it('LeadAttribution com click id em telefone exclusivo (sem AdConversion) = comprovada', () => {
    const r = attributeReceivedRevenue({
      ledgerEntries: [{ _id: 'x', type: 'payment_received', direction: 'credit', amount: 90, patient: 'p1', payment: 'y' }],
      patients: [{ _id: 'p1', phone: PHONES.fabio }],
      leadAttributions: [{ phone: PHONES.fabio, source: 'google_ads', method: 'keyword', gclid: 'G-FICT' }],
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
