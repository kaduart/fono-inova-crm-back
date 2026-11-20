/**
 * Exportador CRM -> KAS Attribution (somente leitura, dados fictícios).
 * O arquivo gerado da amostra fictícia é o MESMO que está em kas-core
 * testdata/attribution/exportado-crm, onde o KAS confere que fecha 480 + 570 + 240 = 1.290.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { toKasInputs, toCsv, kasSource, KAS_COLUMNS } from '../../services/attribution/kasExport.js';
import { loadRevenueInputs, loadRevenueAttribution, attributeReceivedRevenue } from '../../services/attribution/revenueAttribution.js';
import { amostra, ESPERADO } from '../../services/attribution/fixtures/receitaFicticia.js';

const golden = (kind) => fs.readFileSync(path.join(__dirname, 'fixtures', 'kas-export', `${kind}.csv`), 'utf8');

describe('toKasInputs — amostra fictícia', () => {
  const out = toKasInputs(amostra);

  it('gera exatamente os arquivos conferidos pelo KAS (kas-core testdata/attribution/exportado-crm)', () => {
    for (const kind of Object.keys(KAS_COLUMNS)) {
      expect(toCsv(kind, out[kind])).toBe(golden(kind));
    }
  });

  it('exporta só caixa, como o CRM: soma dos recebimentos menos estornos = 1.290', () => {
    const recebido = out.receipts.reduce((s, r) => s + Number(r.amount_cents), 0);
    const estornado = out.refunds.reduce((s, r) => s + Number(r.amount_cents), 0);
    expect((recebido - estornado) / 100).toBe(ESPERADO.total);
    expect(out.ignorados).toMatchObject({ 'fora_do_caixa:revenue_recognition': 1, 'fora_do_caixa:package_consumed': 1, 'fora_do_caixa:insurance_billed': 1, 'fora_do_caixa:reversal': 1, conversao_sem_origem: 1 });
  });

  it('telefone vai só com dígitos e normalizado; nenhuma célula começa fórmula', () => {
    for (const c of out.customers) expect(c.phone).toMatch(/^\d*$/);
    for (const kind of Object.keys(KAS_COLUMNS)) {
      for (const line of toCsv(kind, out[kind]).split('\n').slice(1)) {
        for (const cell of line.split(',')) expect(cell).not.toMatch(/^[=+@-]/);
      }
    }
  });
});

describe('toKasInputs — casos de borda', () => {
  const at = new Date('2026-11-10T15:00:00Z');

  it('atribuição de um telefone sem paciente vira cliente só de telefone', () => {
    const out = toKasInputs({ leadAttributions: [{ _id: 'a1', phone: '5562988887777', source: 'meta_ads', method: 'ctwa', firstMessageAt: at }] });
    expect(out.customers).toEqual([{ external_id: 'tel-a1', phone: '5562988887777' }]);
    expect(out.contacts[0]).toMatchObject({ external_id: 'leadattr-a1', customer_ref: 'tel-a1', acquisition: 'false' });
  });

  it('recebimento sem paciente entra com cliente próprio (cai em sem vínculo no KAS)', () => {
    const out = toKasInputs({ ledgerEntries: [{ _id: 'l1', type: 'payment_received', direction: 'credit', amount: 50.5, occurredAt: at }] });
    expect(out.receipts).toEqual([{ external_id: 'l1', customer_ref: 'sem-cliente-l1', amount_cents: '5050', received_at: at.toISOString(), payment_ref: '' }]);
  });

  it('crédito repetido no período e como referência sai uma vez; reversão usa receipt_ref', () => {
    const credit = { _id: 'c1', type: 'payment_received', direction: 'credit', amount: 100, patient: 'p1', payment: 'pay1', occurredAt: at };
    const out = toKasInputs({
      ledgerEntries: [credit, { _id: 'd1', type: 'reversal', direction: 'debit', amount: 100, patient: 'p1', reversalOfEntryId: 'c1', payment: 'pay1', occurredAt: at }],
      referenceEntries: [credit],
    });
    expect(out.receipts).toHaveLength(1);
    expect(out.refunds[0]).toMatchObject({ receipt_ref: 'c1', payment_ref: '' });
  });

  it('origens fora da lista do KAS', () => {
    expect(kasSource('instagram_ads')).toBe('meta_ads');
    expect(kasSource('unknown')).toBeNull();
    expect(kasSource('outdoor')).toBe('other');
    expect(kasSource('google_ads')).toBe('google_ads');
  });

  it('CSV escapa vírgula e aspas', () => {
    expect(toCsv('customers', [{ external_id: 'a,b', phone: '1"2' }])).toBe('external_id,phone\n"a,b","1""2"\n');
  });
});

describe('loadRevenueInputs — mesma leitura da receita', () => {
  it('loadRevenueAttribution continua igual a attributeReceivedRevenue(loadRevenueInputs())', async () => {
    const q = (rows) => ({ select: () => ({ lean: async () => rows }) });
    const models = {
      FinancialLedger: { find: (f) => q(f.$or ? [] : amostra.ledgerEntries) },
      Patient: { find: () => q(amostra.patients) },
      AdConversion: { find: () => q(amostra.adConversions.filter((c) => c.isAcquisition)) },
      LeadAttribution: { find: () => q(amostra.leadAttributions) },
    };
    const raw = await loadRevenueInputs({ models });
    expect(raw.ledgerEntries).toHaveLength(amostra.ledgerEntries.length);
    const viaLoader = await loadRevenueAttribution({ models });
    expect(viaLoader).toEqual(attributeReceivedRevenue(raw));
    expect(viaLoader.totalLiquidoLedger).toBe(ESPERADO.total);
  });
});
