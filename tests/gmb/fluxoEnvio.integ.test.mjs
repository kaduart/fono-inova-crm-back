/**
 * Teste INTEGRADO isolado: ImageBank -> status do post -> seleção do enviador -> payload Make.
 * Sem produção, sem banco, sem webhook real. Inclui post HISTÓRICO que NÃO pode ser reenviado.
 * Rodar: node tests/gmb/fluxoEnvio.integ.test.mjs
 */
import assert from 'node:assert/strict';
import { buscarImagemBancoPorBase } from '../../services/gmbImageBankMap.js';
import { filtroScheduledForPublish, matchFiltro, podeEnviarAoMake } from '../../services/gmbPublishPolicy.js';

let passed = 0, failed = 0;
const tAsync = async (n, fn) => { try { await fn(); console.log('✅', n); passed++; } catch (e) { console.error('❌', n, '\n    ->', e.message); failed++; } };

// Banco sintético: só fono tem imagem (para exercitar needs_review em psicologia)
const bancoFake = { fonoaudiologia: 'https://cdn/fono.jpg' };
const buscar = async (esp) => (bancoFake[esp] ? { url: bancoFake[esp], publicId: esp } : null);

// Simula createDailyPost: define mediaUrl + status a partir da seleção de imagem
async function simulaCriarPost({ especialidadeId, content, createdAt, scheduledAt }) {
  const img = await buscarImagemBancoPorBase(especialidadeId, content, buscar);
  const mediaUrl = img?.url || null;
  const semImagem = !mediaUrl;
  return {
    _id: Math.random().toString(36).slice(2),
    title: content, content, theme: especialidadeId, ctaUrl: 'https://wa.me/5562992013573',
    mediaUrl, mediaType: mediaUrl ? 'image' : null,
    status: semImagem ? 'needs_review' : 'scheduled',
    error: semImagem ? 'Sem imagem elegível' : undefined,
    createdAt, scheduledAt, nextRetryAt: null,
  };
}

const now = new Date('2026-11-07T19:00:00Z');
const ontem = new Date(now.getTime() - 24 * 3600 * 1000);
const julho = new Date('2026-07-09T10:00:00Z');

await tAsync('1. Fono: gera imagem (base) e vira scheduled', async () => {
  const p = await simulaCriarPost({ especialidadeId: 'fonoaudiologia_infantil_anapolis', content: 'Sua criança não fala?', createdAt: now, scheduledAt: ontem });
  assert.equal(p.status, 'scheduled');
  assert.ok(p.mediaUrl);
});

await tAsync('2. Psicologia: sem imagem -> needs_review (fora da fila)', async () => {
  const p = await simulaCriarPost({ especialidadeId: 'psicologia_infantil_anapolis', content: 'Ansiedade infantil', createdAt: now, scheduledAt: ontem });
  assert.equal(p.status, 'needs_review');
  assert.equal(p.mediaUrl, null);
});

await tAsync('3. Enviador seleciona SÓ o post novo com imagem — exclui backlog histórico', async () => {
  const A = await simulaCriarPost({ especialidadeId: 'fonoaudiologia_infantil_anapolis', content: 'Novo de hoje', createdAt: now, scheduledAt: ontem });
  const B = await simulaCriarPost({ especialidadeId: 'psicologia_infantil_anapolis', content: 'needs_review', createdAt: now, scheduledAt: ontem });
  const C = { _id: 'c', status: 'scheduled', mediaUrl: null, createdAt: now, scheduledAt: ontem, nextRetryAt: null };          // recente SEM imagem
  const D = { _id: 'd', status: 'scheduled', mediaUrl: 'https://cdn/julho.jpg', createdAt: julho, scheduledAt: julho, nextRetryAt: null }; // HISTÓRICO COM imagem
  const E = { _id: 'e', status: 'unconfirmed', mediaUrl: 'https://cdn/x.jpg', createdAt: now, scheduledAt: ontem, nextRetryAt: null };     // já enviado
  const F = { _id: 'f', status: 'published', mediaUrl: 'https://cdn/y.jpg', createdAt: now, scheduledAt: ontem, nextRetryAt: null };       // publicado

  const filtro = filtroScheduledForPublish(now, { maxAgeDays: 4 });
  const selecionados = [A, B, C, D, E, F].filter((p) => matchFiltro(p, filtro));

  assert.deepEqual(selecionados.map((p) => p._id), [A._id], 'só o post novo com imagem deve ser selecionado');
  assert.ok(!matchFiltro(D, filtro), 'post HISTÓRICO de julho (com imagem) NÃO pode ser selecionado');
  assert.ok(!matchFiltro(C, filtro), 'post recente sem imagem não é selecionado');
  assert.ok(!matchFiltro(E, filtro), 'unconfirmed não é reenviado');
});

await tAsync('4. Payload do Make: selecionado tem os campos; imageless é barrado', async () => {
  const A = await simulaCriarPost({ especialidadeId: 'fonoaudiologia_infantil_anapolis', content: 'Novo', createdAt: now, scheduledAt: ontem });
  assert.ok(podeEnviarAoMake(A), 'post com imagem pode ir ao Make');
  for (const campo of ['_id', 'title', 'content', 'mediaUrl', 'ctaUrl', 'theme']) {
    assert.ok(A[campo] != null, `payload do Make precisa do campo ${campo}`);
  }
  assert.equal(podeEnviarAoMake({ mediaUrl: null }), false, 'post sem imagem NÃO vai ao Make');
});

console.log(`\n${passed} passaram, ${failed} falharam`);
process.exit(failed ? 1 : 0);
