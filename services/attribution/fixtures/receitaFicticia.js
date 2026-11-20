// services/attribution/fixtures/receitaFicticia.js
// Amostra 100% FICTÍCIA (nomes, telefones e ids inventados) para testes e para a demonstração
// (scripts/demo-receita-por-campanha.mjs). Reproduz o caso da auditoria:
//   ledger líquido R$ 910 = comprovada 320 + provável 440 + sem vínculo 150; painel antigo R$ 1.540.
//
// Pacientes:
//   Ana   — Google (gclid), telefone só dela ............ payment_received 120          → comprovada 120
//   Bruno — Meta CTWA (ctwaClid), telefone só dele ....... pacote R$ 600, pagou só R$ 200 → comprovada 200
//           (package_purchase 200; o consumo de sessão package_consumed 150 NÃO conta)
//   Carla — TikTok (ttclid), telefone só dela ............ pagou 180 e teve estorno total → 0
//   Davi  — Google (gclid) no telefone da mãe ............ payment_received 200          → provável 200
//   Eva   — irmã do Davi, veio por INDICAÇÃO, mesmo telefone; o cron atribuiu Google pelo telefone
//           ............................................... payment_received 140          → provável 140
//   Fábio — só palavra-chave "instagram" (LeadAttribution), sem AdConversion; convênio
//           ............................................... insurance_received 100 (insurance_billed 200 NÃO conta) → provável 100
//   Gabi  — sem origem (AdConversion unknown) ............ payment_received 150          → sem vínculo 150
// Também: reversão de cancelamento de sessão SEM pagamento (Ana, 80) e revenue_recognition — ficam fora.

const oid = (n) => `0000000000000000000000${String(n).padStart(2, '0')}`;

export const P = {
  ana: oid(1), bruno: oid(2), carla: oid(3), davi: oid(4), eva: oid(5), fabio: oid(6), gabi: oid(7),
};
export const PHONES = {
  ana: '5562999990001', bruno: '5562999990002', carla: '5562999990003',
  maeDaviEva: '5562999990004', fabio: '5562999990006', gabi: '5562999990007',
};

export const patients = [
  { _id: P.ana, phone: '(62) 99999-0001' },              // formato de cadastro, normaliza para o mesmo
  { _id: P.bruno, phone: PHONES.bruno },
  { _id: P.carla, phone: PHONES.carla },
  { _id: P.davi, phone: PHONES.maeDaviEva },
  { _id: P.eva, phone: '556299990004' },                  // mesmo número SEM o 9 (variante)
  { _id: P.fabio, phone: PHONES.fabio },
  { _id: P.gabi, phone: PHONES.gabi },
];

const conv = (n, patient, phone, extra) => ({
  _id: oid(40 + n), appointment: oid(60 + n), patient, phone, isAcquisition: true,
  eventTime: new Date('2026-11-05T13:00:00Z'), done: true,
  meta: { status: 'skipped', reason: 'sem_telefone' }, google: { status: 'skipped', reason: 'sem_gclid' }, tiktok: { status: 'skipped', reason: 'sem_identificador' },
  ...extra,
});

// AdConversion.value somado = 1.540 (o que o painel antigo mostraria)
export const adConversions = [
  conv(1, P.ana, PHONES.ana, { source: 'google_ads', attributionMethod: 'site_signature', campaign: 'gg-fono-infantil', gclid: 'GCLID-FICTICIO-ANA', value: 220 }),
  conv(2, P.bruno, PHONES.bruno, { source: 'meta_ads', attributionMethod: 'ctwa', adId: 'AD-FICTICIO-1', ctwaClid: 'CLID-FICTICIO-BRUNO', value: 600 }),
  conv(3, P.carla, PHONES.carla, { source: 'tiktok_ads', attributionMethod: 'token', campaign: 'tt-avaliacao', ttclid: 'TTCLID-FICTICIO', value: 180 }),
  conv(4, P.davi, PHONES.maeDaviEva, { source: 'google_ads', attributionMethod: 'site_signature', campaign: 'gg-fono-infantil', gclid: 'GCLID-FICTICIO-MAE', value: 220 }),
  conv(5, P.eva, PHONES.maeDaviEva, { source: 'google_ads', attributionMethod: 'site_signature', campaign: 'gg-fono-infantil', gclid: 'GCLID-FICTICIO-MAE', value: 220 }),
  conv(7, P.gabi, PHONES.gabi, { source: 'unknown', unknownReason: 'sem_origem_capturada', value: 100 }),
];

export const leadAttributions = [
  { _id: oid(81), phone: PHONES.maeDaviEva, source: 'google_ads', method: 'site_signature', confidence: 'high', campaign: 'gg-fono-infantil', gclid: 'GCLID-FICTICIO-MAE', firstMessageAt: new Date('2026-10-01T12:00:00Z') },
  { _id: oid(82), phone: PHONES.fabio, source: 'instagram', method: 'keyword', confidence: 'low', firstMessageAt: new Date('2026-10-02T12:00:00Z') },
];

const at = (d) => new Date(`2026-11-${d}T15:00:00Z`);
const entry = (n, type, direction, amount, patient, extra = {}) => ({
  _id: oid(n), type, direction, amount, patient, correlationId: `ficticio-${n}`, occurredAt: at('10'), ...extra,
});

export const ledgerEntries = [
  entry(10, 'payment_received', 'credit', 120, P.ana, { payment: oid(90) }),
  entry(11, 'revenue_recognition', 'credit', 120, P.ana),
  entry(12, 'reversal', 'debit', 80, P.ana, { occurredAt: at('12') }), // cancelamento de sessão: sem payment → fora
  entry(20, 'package_purchase', 'credit', 200, P.bruno, { payment: oid(91), package: oid(95) }), // pacote 600, pago 200
  entry(21, 'package_consumed', 'credit', 150, P.bruno, { package: oid(95) }),
  entry(30, 'payment_received', 'credit', 180, P.carla, { payment: oid(92) }),
  entry(31, 'refund', 'debit', 180, P.carla, { payment: oid(92), occurredAt: at('14') }),
  entry(40, 'payment_received', 'credit', 200, P.davi, { payment: oid(93) }),
  entry(50, 'payment_received', 'credit', 140, P.eva, { payment: oid(94) }),
  entry(60, 'insurance_billed', 'credit', 200, P.fabio, { payment: oid(96), billingType: 'convenio' }),
  entry(61, 'insurance_received', 'credit', 100, P.fabio, { payment: oid(96), billingType: 'convenio' }),
  entry(70, 'payment_received', 'credit', 150, P.gabi, { payment: oid(97) }),
];

export const amostra = { ledgerEntries, adConversions, leadAttributions, patients };

export const ESPERADO = { total: 910, comprovada: 320, provavel: 440, sem_vinculo: 150, painelAntigo: 1540 };
