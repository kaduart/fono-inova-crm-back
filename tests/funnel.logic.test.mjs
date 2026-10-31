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
  '5562990000099': { booked: true, pre: false }, // ÓRFÃO: agendamento sem Lead/contato vinculado
  '5562990000098': { booked: false, pre: true }, // ÓRFÃO: pré-agendamento sem Lead
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
t('agendamento SEM Lead vinculado aparece em semVinculo, NÃO na conversão', () => {
  const { semVinculo } = buildChannelFunnel({ contacts, apptStatusByPhone });
  assert.equal(semVinculo.agendamentos, 1);     // telefone 099
  assert.equal(semVinculo.preAgendamentos, 1);  // telefone 098
  // órfãos não entram em contatos nem na taxa de conversão
  assert.equal(totals.contatos, 5);
});

console.log('\n#mergeContacts — contatos vêm dos LEADS; atribuição só dá o canal');
t('base = leads (inclui sem atribuição); atribuição enriquece o canal; dedup por telefone', () => {
  const merged = mergeContacts({
    attributed: [{ phone: '55A', channel: 'meta_ads' }, { phone: '55C', channel: 'tiktok_ads' }],
    leads: [{ phone: '55A' }, { phone: '55B' }, { phone: '55A' }],
  });
  assert.equal(merged.length, 2); // 55A (dedup) + 55B; 55C NÃO entra (não é lead)
  assert.equal(merged.find((m) => m.phone === '55A').channel, 'meta_ads');
  assert.equal(merged.find((m) => m.phone === '55B').channel, null); // -> nao_identificado
  assert.equal(merged.find((m) => m.phone === '55C'), undefined); // atribuído-only não conta como contato
});

console.log('\n#Entrega — ACEITA COMPROVADA (resposta API) vs ENVIADO HISTÓRICO (sem prova)');
const now = new Date();
const docs = [
  // sent COM prova (events_received>=1 / trace) = aceita comprovada
  { meta: { status: 'sent', sentAt: new Date(now - 3600e3), eventsReceived: 1, trace: 'fb1' }, google: { status: 'skipped', reason: 'sem_gclid' }, tiktok: { status: 'sent', sentAt: now, code: 0, trace: 'req1' } },
  // sent SEM prova (gravação antiga) = enviado histórico
  { meta: { status: 'sent', sentAt: now }, google: { status: 'sent', sentAt: now }, tiktok: { status: 'sent', sentAt: new Date(now - 7200e3) } },
  { meta: { status: 'failed', reason: 'meta_events_received_0' }, google: { status: 'skipped', reason: 'sem_gclid' }, tiktok: { status: 'skipped', reason: 'fora_janela_7d_tiktok' } },
  { meta: { status: 'skipped', reason: 'sem_telefone' } },
  { done: true, tiktok: { status: 'pending', reason: null } }, // pending em registro done = inconsistência
];
const d = summarizeDelivery(docs);
t('Meta: 1 aceita (events_received>=1) + 1 histórico (sent sem prova), 1 falha, 1 ignorada', () => {
  assert.equal(d.meta.accepted, 1);     // só a com events_received>=1
  assert.equal(d.meta.sentLegacy, 1);   // a sent sem prova = histórico
  assert.equal(d.meta.failed, 1);
  assert.equal(d.meta.ignored, 1);
  assert.equal(d.meta.reasons['meta_events_received_0'], 1);
  assert.equal(d.meta.reasons['sem_telefone'], 1);
  assert.equal(d.meta.lastSentAt, now.toISOString());
});
t('TikTok: aceita SÓ com code:0; sent com request_id mas sem code = histórico', () => {
  assert.equal(d.tiktok.accepted, 1);   // a com code:0
  assert.equal(d.tiktok.sentLegacy, 1); // sent sem code (mesmo com/sem trace) = histórico
  assert.equal(d.tiktok.ignored, 1);
  assert.equal(d.tiktok.reasons['fora_janela_7d_tiktok'], 1);
});
t('pending em registro done conta como INCONSISTÊNCIA, não como pendência ativa', () => {
  // o doc extra tem tiktok pending + done:true
  assert.equal(d.tiktok.inconsistent, 1); // doc com done:true + tiktok pending
  assert.equal(d.tiktok.pending, 0);      // nenhum pending ATIVO (done:false) no cenário
});
t('Google: sucesso de upload conta como aceito (API confirma); ignoradas por sem_gclid', () => {
  assert.equal(d.google.accepted, 1);   // google sent = confirmado pela API
  assert.equal(d.google.sentLegacy, 0);
  assert.equal(d.google.ignored, 2);
  assert.equal(d.google.reasons['sem_gclid'], 2);
});

console.log(`\n==== ${pass} passaram, ${fail} falharam ====`);
process.exit(fail ? 1 : 0);
