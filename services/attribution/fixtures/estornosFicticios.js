// services/attribution/fixtures/estornosFicticios.js
// Amostra 100% FICTÍCIA dos casos de estorno da revisão do analista (20/11), regra
// estorno-v3-saldo-por-recebimento. Período consultado: 01/11 a 30/11/2026.
//
// Caso 1 (Lara, pagamento pay-1): R$ 100 recebidos ANTES do anúncio (sem vínculo) e R$ 300
//   DEPOIS (Google, gg-caso-1). Estorno exato dos R$ 100; depois estorno geral de R$ 200.
//   O geral só pode sair dos R$ 300 (os R$ 100 já foram estornados):
//   esperado sem vínculo 100 − 100 = 0 e campanha 300 − 200 = 100 (antes: −50 e 150).
// Caso 2 (Mateus, pay-2): estorno de R$ 50 só com o pagamento, ANTES de todo recebimento do
//   pagamento (R$ 500 recebidos depois, Google gg-caso-2). Não herda a campanha futura:
//   esperado −50 em sem vínculo (estorno_antes_do_recebimento) e campanha +500.
// Caso 3 (Nina, pay-3): R$ 200 em 10/10 (antes do anúncio, sem vínculo) e R$ 200 em 20/10
//   (Google gg-caso-3), ambos fora do período; estorno exato dos R$ 200 de 10/10 em 25/10
//   (também fora do período). Em 05/11, estorno geral de R$ 100: só cabe nos R$ 200 de 20/10.
//   Esperado campanha −100 (antes: −50 na campanha e −50 em sem vínculo).
//
// Total do período: recebido 900 − estornos 450 = 450 = comprovada 500 + sem vínculo −50.

const oid = (n) => `00000000000000000000e${String(n).padStart(3, '0')}`;

export const PE = { lara: oid(1), mateus: oid(2), nina: oid(3) };
const PHONES = { lara: '5562999991001', mateus: '5562999991002', nina: '5562999991003' };

const patients = [
  { _id: PE.lara, phone: PHONES.lara },
  { _id: PE.mateus, phone: PHONES.mateus },
  { _id: PE.nina, phone: PHONES.nina },
];

const conv = (n, patient, phone, campaign, eventTime) => ({
  _id: oid(40 + n), appointment: oid(60 + n), patient, phone, isAcquisition: true, done: true,
  source: 'google_ads', attributionMethod: 'site_signature', campaign, gclid: `GCLID-FICTICIO-CASO-${n}`,
  eventTime: new Date(eventTime), value: 220,
});
const adConversions = [
  conv(1, PE.lara, PHONES.lara, 'gg-caso-1', '2026-11-10T13:00:00Z'),
  conv(2, PE.mateus, PHONES.mateus, 'gg-caso-2', '2026-10-01T13:00:00Z'),
  conv(3, PE.nina, PHONES.nina, 'gg-caso-3', '2026-10-15T13:00:00Z'),
];

const e = (n, type, direction, amount, patient, payment, occurredAt, extra = {}) => ({
  _id: oid(n), type, direction, amount, patient, payment, occurredAt: new Date(occurredAt), correlationId: `ficticio-e${n}`, ...extra,
});

// Lançamentos do período (01/11 a 30/11).
const ledgerEntries = [
  e(101, 'payment_received', 'credit', 100, PE.lara, oid(901), '2026-11-05T15:00:00Z'),
  e(102, 'payment_received', 'credit', 300, PE.lara, oid(901), '2026-11-15T15:00:00Z'),
  e(103, 'refund', 'debit', 100, PE.lara, oid(901), '2026-11-16T15:00:00Z', { reversalOfEntryId: oid(101) }),
  e(104, 'refund', 'debit', 200, PE.lara, oid(901), '2026-11-20T15:00:00Z'),
  e(201, 'refund', 'debit', 50, PE.mateus, oid(902), '2026-11-22T15:00:00Z'),
  e(202, 'payment_received', 'credit', 500, PE.mateus, oid(902), '2026-11-25T15:00:00Z'),
  e(303, 'refund', 'debit', 100, PE.nina, oid(903), '2026-11-05T16:00:00Z'),
];
// Fora do período: o que o carregador traz como referência (recebimentos e estorno anterior).
const referenceEntries = [
  e(301, 'payment_received', 'credit', 200, PE.nina, oid(903), '2026-10-10T15:00:00Z'),
  e(302, 'payment_received', 'credit', 200, PE.nina, oid(903), '2026-10-20T15:00:00Z'),
  e(304, 'refund', 'debit', 200, PE.nina, oid(903), '2026-10-25T15:00:00Z', { reversalOfEntryId: oid(301) }),
];

export const amostraEstornos = { ledgerEntries, referenceEntries, adConversions, leadAttributions: [], patients };

// Em reais. Linhas por campanha (líquido).
export const ESPERADO_ESTORNOS = {
  total: 450, comprovada: 500, provavel: 0, sem_vinculo: -50,
  campanhas: { 'gg-caso-1': 100, 'gg-caso-2': 500, 'gg-caso-3': -100 },
  semVinculoMotivos: { contato_da_campanha_depois_do_recebimento: 0, estorno_antes_do_recebimento: -50 },
};
