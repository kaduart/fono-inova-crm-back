// tests/adsConversion.logic.test.mjs
// Testes PUROS (sem DB, sem rede) da lógica do cron de conversões de anúncio.
// Rodar: node tests/adsConversion.logic.test.mjs
import assert from 'node:assert/strict';
import {
  BOOKED_STATUSES, isEligibleStatus, resolveMainPhone,
  decidePlatforms, interpretMetaResponse, interpretTiktokResponse, buildFbc,
  resolveConversionTime, shouldAcquire, eventIdFor, buildPendingClaim,
} from '../crons/adsConversion.logic.js';

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ✓', name); } catch (e) { fail++; console.log('  ✗', name, '\n      ', e.message); } }

const DAY = 864e5;
const now = Date.now();
const freshMs = now - 60 * 60 * 1000;      // 1h atrás (dentro das janelas)
const oldMs = now - 10 * DAY;              // 10 dias atrás (fora das janelas 7d)

// nº válidos (E.164 BR): 55 + DDD + 8/9 dígitos
const P_INFO = '(11) 98765-4321';          // válido -> 5511987654321
const P_PAT  = '21 99999-8888';            // válido -> 5521999998888
const INVALID = '123';

console.log('\n#1 Telefone — principal, fallback, números distintos, emergência');
t('prioriza contato do atendimento (patientInfo) sobre o do paciente', () => {
  assert.equal(resolveMainPhone({ patientInfoPhone: P_INFO, patientPhone: P_PAT }), '5511987654321');
});
t('fallback para Patient.phone quando patientInfo ausente', () => {
  assert.equal(resolveMainPhone({ patientInfoPhone: null, patientPhone: P_PAT }), '5521999998888');
});
t('números DISTINTOS não bloqueiam — retorna o de maior prioridade válido', () => {
  const r = resolveMainPhone({ patientInfoPhone: P_INFO, patientPhone: P_PAT });
  assert.equal(r, '5511987654321'); // não null, não erro
});
t('patientInfo inválido cai para Patient.phone válido', () => {
  assert.equal(resolveMainPhone({ patientInfoPhone: INVALID, patientPhone: P_PAT }), '5521999998888');
});
t('ambos inválidos/ausentes -> null (sem_telefone)', () => {
  assert.equal(resolveMainPhone({ patientInfoPhone: INVALID, patientPhone: null }), null);
  assert.equal(resolveMainPhone({}), null);
});
t('emergência nunca entra (função só conhece patientInfo e patient)', () => {
  // o resolvedor não aceita campo de emergência; passá-lo é ignorado
  assert.equal(resolveMainPhone({ patientInfoPhone: null, patientPhone: null, emergencyContactPhone: P_PAT }), null);
});

console.log('\n#2 Elegibilidade — projeção (pre_agendado) vs agendamento real (inclui convênio)');
t('pre_agendado (projeção/aguarda confirmação) NÃO é elegível', () => {
  assert.equal(isEligibleStatus('pre_agendado'), false);
});
t('scheduled/confirmed/paid/completed são elegíveis', () => {
  for (const s of ['scheduled', 'confirmed', 'paid', 'completed']) assert.equal(isEligibleStatus(s), true);
});
t('convênio real (scheduled) é elegível — não excluído por origem', () => {
  // elegibilidade olha status, não metadata.origin.source=insurance_plan
  assert.equal(isEligibleStatus('scheduled'), true);
});
t('BOOKED_STATUSES não contém pre_agendado', () => {
  assert.ok(!BOOKED_STATUSES.includes('pre_agendado'));
});

console.log('\n#3 Remarcação / aquisição — preserva original, marca isAcquisition');
t('1ª vez do paciente -> isAcquisition=true', () => {
  const d = decidePlatforms({ first: true, phone: '5511987654321', attr: {}, eventTimeMs: freshMs, now });
  assert.equal(d.isAcquisition, true);
});
t('não-primeiro (remarcação de paciente já adquirido) -> isAcquisition=false, tudo skipped, done', () => {
  const d = decidePlatforms({ first: false, phone: '5511987654321', attr: { ttclid: 'x' }, eventTimeMs: freshMs, now });
  assert.equal(d.isAcquisition, false);
  assert.equal(d.done, true);
  assert.equal(d.meta.reason, 'nao_e_primeiro_agendamento');
  assert.equal(d.google.reason, 'nao_e_primeiro_agendamento');
  assert.equal(d.tiktok.reason, 'nao_e_primeiro_agendamento');
});

console.log('\n#4/#5 Enqueue de plataforma — janelas, telefone-only TikTok, idempotência');
t('#5 TikTok com telefone e SEM ttclid -> pending (telefone-only aceito)', () => {
  const d = decidePlatforms({ first: true, phone: '5511987654321', attr: {}, eventTimeMs: freshMs, now });
  assert.equal(d.tiktok.status, 'pending');
  assert.equal(d.ttclid, null);
});
t('TikTok sem telefone e sem ttclid -> skipped sem_identificador', () => {
  const d = decidePlatforms({ first: true, phone: null, attr: {}, eventTimeMs: freshMs, now });
  assert.equal(d.tiktok.status, 'skipped');
  assert.equal(d.tiktok.reason, 'sem_identificador');
  assert.equal(d.meta.reason, 'sem_telefone');
});
t('Meta: sem telefone -> skipped sem_telefone', () => {
  const d = decidePlatforms({ first: true, phone: null, attr: { gclid: 'g' }, eventTimeMs: freshMs, now });
  assert.equal(d.meta.reason, 'sem_telefone');
  assert.equal(d.google.status, 'pending'); // gclid presente
});
t('fora da janela de 7 dias -> skipped fora_janela (meta e tiktok)', () => {
  const d = decidePlatforms({ first: true, phone: '5511987654321', attr: { ttclid: 'x' }, eventTimeMs: oldMs, now });
  assert.equal(d.meta.reason, 'fora_janela_7d_meta');
  assert.equal(d.tiktok.reason, 'fora_janela_7d_tiktok');
});
t('fbc construído a partir de fbclid', () => {
  const d = decidePlatforms({ first: true, phone: '5511987654321', attr: { fbclid: 'abc', firstMessageAt: new Date(freshMs).toISOString() }, eventTimeMs: freshMs, now });
  assert.ok(d.fbc.startsWith('fb.1.'));
  assert.ok(d.fbc.endsWith('.abc'));
});
t('decisão idempotente — execução repetida/concorrente produz o MESMO resultado', () => {
  const args = { first: true, phone: '5511987654321', attr: { ttclid: 't' }, eventTimeMs: freshMs, now };
  assert.deepEqual(decidePlatforms(args), decidePlatforms(args));
  // ambas pedem isAcquisition=true -> a unicidade por paciente (índice parcial no DB)
  // garante que só UMA linha de aquisição sobreviva sob concorrência.
  assert.equal(decidePlatforms(args).isAcquisition, true);
});

console.log('\n#4 Respostas das APIs — sucesso e falha (simuladas), sem marcar falha como sucesso');
t('Meta events_received>=1 -> sent + persiste eventsReceived/trace/pixel', () => {
  const r = interpretMetaResponse({ events_received: 1, fbtrace_id: 'AbC' }, { pixel: '4071257099804730', event: 'Purchase', actionSource: 'physical_store' });
  assert.equal(r.status, 'sent');
  assert.equal(r.eventsReceived, 1);
  assert.equal(r.trace, 'AbC');
  assert.equal(r.pixel, '4071257099804730');
  assert.equal(r.event, 'Purchase');
  assert.equal(r.actionSource, 'physical_store');
});
t('Meta events_received:0 -> NÃO é sent (failed, não-retryable)', () => {
  const r = interpretMetaResponse({ events_received: 0, messages: ['Invalid param'] }, { pixel: 'p' });
  assert.equal(r.status, 'failed');
  assert.notEqual(r.status, 'sent');
  assert.equal(r.retryable, false);
  assert.ok(r.reason.includes('Invalid param'));
});
t('Meta sem resposta (não configurado) -> skipped', () => {
  assert.equal(interpretMetaResponse(undefined, {}).status, 'skipped');
  assert.equal(interpretMetaResponse(null, {}).reason, 'meta_capi_nao_configurado');
});
t('TikTok code:0 -> sent + request_id como trace', () => {
  const r = interpretTiktokResponse({ code: 0, request_id: 'req_1' }, { pixel: 'DB3PQARC77UA626EKV60' });
  assert.equal(r.status, 'sent');
  assert.equal(r.trace, 'req_1');
  assert.equal(r.pixel, 'DB3PQARC77UA626EKV60');
});
t('TikTok null (não configurado/sem id) -> skipped', () => {
  assert.equal(interpretTiktokResponse(null, {}).status, 'skipped');
});
t('TikTok code != 0 -> failed (não é sucesso)', () => {
  const r = interpretTiktokResponse({ code: 40002, message: 'bad', request_id: 'r' }, {});
  assert.equal(r.status, 'failed');
  assert.notEqual(r.status, 'sent');
});


console.log('\n#1b Regra de aquisição (shouldAcquire) — independe do original continuar elegível');
t('sem patient -> aquisição', () => assert.equal(shouldAcquire({ hasPatient: false }), true));
t('já adquirido -> não', () => assert.equal(shouldAcquire({ hasPatient: true, alreadyAcquired: true }), false));
t('anterior já convertido (legado) -> não duplica', () => assert.equal(shouldAcquire({ hasPatient: true, alreadyAcquired: false, earlierConverted: true }), false));
t('anterior ainda elegível -> defere (não é a âncora)', () => assert.equal(shouldAcquire({ hasPatient: true, alreadyAcquired: false, earlierConverted: false, earlierEligibleExists: true }), false));
t('original cancelado/inelegível e sem conversão -> ESTE é a aquisição', () => assert.equal(shouldAcquire({ hasPatient: true, alreadyAcquired: false, earlierConverted: false, earlierEligibleExists: false }), true));

console.log('\n#2b Data comprovada da conversão (resolveConversionTime)');
t('usa timestamp da transição p/ booked no histórico (não createdAt)', () => {
  const tConf = new Date('2026-10-30T12:00:00Z');
  const appt = { createdAt: new Date('2026-09-01T00:00:00Z'), history: [
    { timestamp: new Date('2026-09-01T00:00:00Z'), details: { from: 'x', to: 'pre_agendado' } },
    { timestamp: tConf, details: { from: 'pre_agendado', to: 'scheduled' } },
  ] };
  assert.equal(resolveConversionTime(appt).getTime(), tConf.getTime());
});
t('aceita newStatus além de details.to', () => {
  const tConf = new Date('2026-10-20T09:00:00Z');
  const appt = { createdAt: new Date('2026-09-01T00:00:00Z'), history: [ { timestamp: tConf, newStatus: 'confirmed' } ] };
  assert.equal(resolveConversionTime(appt).getTime(), tConf.getTime());
});
t('pega a PRIMEIRA transição booked quando há várias', () => {
  const t1 = new Date('2026-10-10T10:00:00Z'), t2 = new Date('2026-10-15T10:00:00Z');
  const appt = { createdAt: new Date('2026-09-01T00:00:00Z'), history: [
    { timestamp: t2, details: { to: 'confirmed' } }, { timestamp: t1, details: { to: 'scheduled' } },
  ] };
  assert.equal(resolveConversionTime(appt).getTime(), t1.getTime());
});
t('sem evidência no histórico -> createdAt (não inventa data)', () => {
  const cd = new Date('2026-10-01T00:00:00Z');
  assert.equal(resolveConversionTime({ createdAt: cd, history: [] }).getTime(), cd.getTime());
  assert.equal(resolveConversionTime({ createdAt: cd }).getTime(), cd.getTime());
});
t('nunca usa updatedAt', () => {
  const cd = new Date('2026-10-01T00:00:00Z');
  const appt = { createdAt: cd, updatedAt: new Date('2026-10-31T00:00:00Z'), history: [] };
  assert.equal(resolveConversionTime(appt).getTime(), cd.getTime()); // = createdAt, não updatedAt
});
t('confirmação tardia: event_time recente entra na janela de 7d (é enviável)', () => {
  const now = Date.now();
  const appt = { createdAt: new Date(now - 40 * 864e5), history: [ { timestamp: new Date(now - 60 * 1000), details: { to: 'scheduled' } } ] };
  const et = resolveConversionTime(appt);
  const d = decidePlatforms({ first: true, phone: '5562992013573', attr: {}, eventTimeMs: et.getTime(), now });
  assert.equal(d.meta.status, 'pending'); // dentro da janela por causa do event_time comprovado
});

console.log('\n#3b event_id estável e reserva atômica (buildPendingClaim)');
t('eventIdFor é determinístico por agendamento', () => {
  assert.equal(eventIdFor('abc123'), 'appt_abc123');
  assert.equal(eventIdFor('abc123'), eventIdFor('abc123'));
});
t('buildPendingClaim: filtro de pendente + lease que empurra nextAttemptAt p/ frente', () => {
  const now = Date.now(), lease = 5 * 60 * 1000;
  const c = buildPendingClaim(now, lease);
  assert.equal(c.filter.done, false);
  assert.ok(c.filter.nextAttemptAt.$lte instanceof Date);
  assert.equal(c.filter.nextAttemptAt.$lte.getTime(), now);
  assert.equal(c.update.$set.nextAttemptAt.getTime(), now + lease); // reserva empurra p/ frente
  assert.deepEqual(c.options.sort, { createdAt: 1 });
  assert.equal(c.options.new, true);
});

console.log(`\n==== ${pass} passaram, ${fail} falharam ====`);
process.exit(fail ? 1 : 0);
