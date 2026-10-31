// tests/funnel.logic.test.mjs — validação PURA (sem DB) do funil e da entrega.
// Rodar: node tests/funnel.logic.test.mjs
import assert from 'node:assert/strict';
import { buildChannelFunnel, mergeContacts, summarizeDelivery } from '../routes/analytics/funnel.logic.js';

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  ✓', n); } catch (e) { fail++; console.log('  ✗', n, '\n      ', e.message); } };

console.log('\n#Funil — casos conhecidos (contato s/ agendamento, pré, real, remarcação, desconhecido)');
// contatos (deduplicados por telefone) com canal da atribuição; p5 sem canal
const contacts = [
  { phone: '5562990000001', channel: 'meta_ads' },   // real
  { phone: '5562990000002', channel: 'meta_ads' },   // pré-agendamento pendente
  { phone: '5562990000003', channel: 'tiktok_ads' }, // sem agendamento
  { phone: '5562990000004', channel: 'meta_ads' },   // remarcação -> real (colapsado)
  { phone: '5562990000005', channel: null },         // origem desconhecida -> real
];
const apptStatusByPhone = {
  '5562990000001': { booked: true, pre: false },
  '5562990000002': { booked: false, pre: true },
  // 003 sem entrada (contato sem agendamento)
  '5562990000004': { booked: true, pre: true }, // tinha pré e virou real (remarcação) -> conta como agendamento, não pré
  '5562990000005': { booked: true, pre: false },
};
const { rows, totals } = buildChannelFunnel({ contacts, apptStatusByPhone });
const row = (ch) => rows.find((r) => r.channel === ch);

t('contato sem agendamento conta em contatos, não em agendamentos', () => {
  assert.equal(row('tiktok_ads').contatos, 1);
  assert.equal(row('tiktok_ads').agendamentos, 0);
  assert.equal(row('tiktok_ads').preAgendamentos, 0);
});
t('pré-agendamento pendente conta em preAgendamentos (não em agendamentos)', () => {
  // meta_ads: p1 real, p2 pré, p4 real => contatos 3, agend 2, pré 1
  assert.equal(row('meta_ads').contatos, 3);
  assert.equal(row('meta_ads').agendamentos, 2);
  assert.equal(row('meta_ads').preAgendamentos, 1);
});
t('remarcação (pré + real no mesmo contato) conta como 1 agendamento, não duplica', () => {
  // p4 tinha pre+booked -> entra só em agendamentos; não soma em pré
  assert.equal(row('meta_ads').agendamentos, 2); // p1 e p4
});
t('origem desconhecida vai para nao_identificado (não inventa canal)', () => {
  assert.equal(row('nao_identificado').contatos, 1);
  assert.equal(row('nao_identificado').agendamentos, 1);
});
t('conversão = agendamentos/contatos do MESMO canal', () => {
  assert.equal(row('meta_ads').conversao, +(2 / 3).toFixed(4));
  assert.equal(row('tiktok_ads').conversao, 0);
});
t('totais batem com os contatos usados (5 contatos, 3 agend, 1 pré)', () => {
  assert.equal(totals.contatos, 5);
  assert.equal(totals.agendamentos, 3);   // p1, p4, p5
  assert.equal(totals.preAgendamentos, 1); // p2
  assert.equal(totals.conversao, +(3 / 5).toFixed(4));
});

console.log('\n#mergeContacts — dedup por telefone, atribuído vence nao_identificado');
t('atribuído prevalece sobre lead sem canal; dedup por telefone', () => {
  const merged = mergeContacts({
    attributed: [{ phone: '55A', channel: 'meta_ads' }],
    leads: [{ phone: '55A' }, { phone: '55B' }],
  });
  assert.equal(merged.length, 2);
  assert.equal(merged.find((m) => m.phone === '55A').channel, 'meta_ads');
  assert.equal(merged.find((m) => m.phone === '55B').channel, null); // -> nao_identificado no funil
});

console.log('\n#Entrega — pendente/aceita/ignorada(motivos)/falha/último envio');
const now = new Date();
const docs = [
  { meta: { status: 'sent', sentAt: new Date(now - 3600e3) }, google: { status: 'skipped', reason: 'sem_gclid' }, tiktok: { status: 'skipped', reason: 'sem_identificador' } },
  { meta: { status: 'sent', sentAt: now }, google: { status: 'skipped', reason: 'sem_gclid' }, tiktok: { status: 'pending' } },
  { meta: { status: 'failed', reason: 'meta_events_received_0' }, google: { status: 'skipped', reason: 'sem_gclid' }, tiktok: { status: 'skipped', reason: 'fora_janela_7d_tiktok' } },
  { meta: { status: 'skipped', reason: 'sem_telefone' } },
];
const d = summarizeDelivery(docs);
t('Meta: 2 aceitas, 1 falha (events_received:0), 1 ignorada (sem_telefone), último envio = agora', () => {
  assert.equal(d.meta.accepted, 2);
  assert.equal(d.meta.failed, 1);
  assert.equal(d.meta.ignored, 1);
  assert.equal(d.meta.reasons['meta_events_received_0'], 1);
  assert.equal(d.meta.reasons['sem_telefone'], 1);
  assert.equal(d.meta.lastSentAt, now.toISOString());
});
t('Google: 3 ignoradas por sem_gclid', () => {
  assert.equal(d.google.ignored, 3);
  assert.equal(d.google.reasons['sem_gclid'], 3);
  assert.equal(d.google.accepted, 0);
});
t('TikTok: 1 pendente + ignoradas com motivos distintos; nenhuma aceita', () => {
  assert.equal(d.tiktok.pending, 1);
  assert.equal(d.tiktok.ignored, 2);
  assert.equal(d.tiktok.reasons['sem_identificador'], 1);
  assert.equal(d.tiktok.reasons['fora_janela_7d_tiktok'], 1);
  assert.equal(d.tiktok.accepted, 0);
  assert.equal(d.tiktok.lastSentAt, null);
});

console.log(`\n==== ${pass} passaram, ${fail} falharam ====`);
process.exit(fail ? 1 : 0);
