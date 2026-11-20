/**
 * Estornos pelo saldo de cada recebimento (estorno-v3-saldo-por-recebimento), dados fictícios.
 * Casos da revisão do analista (20/11): estorno geral depois de um estorno exato, estorno
 * anterior a todo recebimento do pagamento e estorno anterior ao período que já consumiu saldo.
 * A mesma amostra exportada (fixtures/kas-export-estornos) é conferida no kas-core
 * (testdata/attribution/estornos-saldo) com os mesmos valores por campanha.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { attributeReceivedRevenue, REFUND_RULE_VERSION } from '../../services/attribution/revenueAttribution.js';
import { toKasInputs, toCsv, KAS_COLUMNS } from '../../services/attribution/kasExport.js';
import { amostraEstornos, ESPERADO_ESTORNOS, PE } from '../../services/attribution/fixtures/estornosFicticios.js';

const porCampanha = (r) => Object.fromEntries(r.linhas.map((l) => [l.campanha, l.liquido]));

describe('estornos pelo saldo do recebimento — amostra do analista', () => {
  const r = attributeReceivedRevenue(amostraEstornos);

  it('cada campanha, o sem vínculo e o total fecham', () => {
    expect(r.regras.estorno).toBe('estorno-v3-saldo-por-recebimento');
    expect(REFUND_RULE_VERSION).toBe('estorno-v3-saldo-por-recebimento');
    expect(r.totalLiquidoLedger).toBe(ESPERADO_ESTORNOS.total);
    expect(r.porNivel).toEqual({ comprovada: ESPERADO_ESTORNOS.comprovada, provavel: 0, sem_vinculo: ESPERADO_ESTORNOS.sem_vinculo });
    expect(porCampanha(r)).toEqual(ESPERADO_ESTORNOS.campanhas);
    expect(r.semVinculo.motivos).toEqual(ESPERADO_ESTORNOS.semVinculoMotivos);
    expect(r.invariante.fecha).toBe(true);
  });

  it('caso 1: o estorno geral não desconta de novo a parcela já estornada', () => {
    const lara = { ...amostraEstornos, ledgerEntries: amostraEstornos.ledgerEntries.filter((e) => e.patient === PE.lara) };
    const x = attributeReceivedRevenue(lara);
    expect(porCampanha(x)).toEqual({ 'gg-caso-1': 100 });
    expect(x.porNivel.sem_vinculo).toBe(0);
    expect(x.totalLiquidoLedger).toBe(100);
  });

  it('caso 2: estorno anterior a todo recebimento não herda a campanha futura', () => {
    const mateus = { ...amostraEstornos, ledgerEntries: amostraEstornos.ledgerEntries.filter((e) => e.patient === PE.mateus) };
    const x = attributeReceivedRevenue(mateus);
    expect(porCampanha(x)).toEqual({ 'gg-caso-2': 500 });
    expect(x.semVinculo.motivos).toEqual({ estorno_antes_do_recebimento: -50 });
    expect(x.totalLiquidoLedger).toBe(450);
  });

  it('caso 3: estorno anterior ao período reduz o saldo da parcela', () => {
    const nina = { ...amostraEstornos, ledgerEntries: amostraEstornos.ledgerEntries.filter((e) => e.patient === PE.nina) };
    expect(porCampanha(attributeReceivedRevenue(nina))).toEqual({ 'gg-caso-3': -100 });
    // sem o estorno anterior (referência), o geral seria rateado meio a meio
    const semAnterior = { ...nina, referenceEntries: nina.referenceEntries.filter((e) => e.type !== 'refund') };
    const y = attributeReceivedRevenue(semAnterior);
    expect(porCampanha(y)).toEqual({ 'gg-caso-3': -50 });
    expect(y.porNivel.sem_vinculo).toBe(-50);
  });

  it('o que passa do saldo fica em sem vínculo (estorno_acima_do_saldo) e o total fecha', () => {
    const extra = { _id: 'e-acima', type: 'refund', direction: 'debit', amount: 150, patient: PE.lara, payment: amostraEstornos.ledgerEntries[0].payment, occurredAt: new Date('2026-11-28T15:00:00Z') };
    const x = attributeReceivedRevenue({ ...amostraEstornos, ledgerEntries: [...amostraEstornos.ledgerEntries, extra] });
    expect(porCampanha(x)['gg-caso-1']).toBe(0);
    expect(x.semVinculo.motivos.estorno_acima_do_saldo).toBe(-50);
    expect(x.invariante.fecha).toBe(true);
  });

  it('rateio em centavos pelo saldo não passa do saldo de nenhuma parcela', () => {
    const pay = 'pay-c';
    const cred = (n, amount, d) => ({ _id: `c${n}`, type: 'payment_received', direction: 'credit', amount, patient: PE.lara, payment: pay, occurredAt: new Date(`2026-11-${d}T15:00:00Z`) });
    const x = attributeReceivedRevenue({
      ...amostraEstornos,
      ledgerEntries: [cred(1, 0.01, '05'), cred(2, 0.01, '15'), cred(3, 99.98, '16'),
        { _id: 'r1', type: 'refund', direction: 'debit', amount: 100, patient: PE.lara, payment: pay, occurredAt: new Date('2026-11-20T15:00:00Z') }],
      referenceEntries: [],
    });
    expect(x.totalLiquidoLedger).toBe(0);
    expect(x.porNivel).toEqual({ comprovada: 0, provavel: 0, sem_vinculo: 0 });
  });
});

describe('exportação da amostra de estornos para o KAS', () => {
  it('gera os arquivos conferidos pelo KAS (kas-core testdata/attribution/estornos-saldo)', () => {
    const out = toKasInputs(amostraEstornos);
    for (const kind of Object.keys(KAS_COLUMNS)) {
      expect(toCsv(kind, out[kind])).toBe(fs.readFileSync(path.join(__dirname, 'fixtures', 'kas-export-estornos', `${kind}.csv`), 'utf8'));
    }
    // o estorno anterior ao período também vai (o KAS guarda o histórico e consome o saldo)
    expect(out.refunds.map((f) => f.external_id)).toContain(amostraEstornos.referenceEntries[2]._id);
  });
});
