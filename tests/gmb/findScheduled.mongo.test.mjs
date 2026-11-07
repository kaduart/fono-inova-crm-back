/**
 * Teste com MongoDB ISOLADO (in-memory) — exercita a CONSULTA REAL do model
 * GmbPost.findScheduledForPublish(). Sem conexão com produção.
 * Requer: mongoose + mongodb-memory-server. Rodar: node tests/gmb/findScheduled.mongo.test.mjs
 */
import assert from 'node:assert/strict';

// Dependências opcionais — teste pula (exit 0) se faltarem, para não quebrar o CI.
let mongoose, MongoMemoryServer, GmbPost;
try {
  mongoose = (await import('mongoose')).default;
  ({ MongoMemoryServer } = await import('mongodb-memory-server'));
  ({ default: GmbPost } = await import('../../models/GmbPost.js'));
} catch {
  console.log('⏭️  Pulando: instale com `npm i -D mongodb-memory-server`. Lógica coberta por fluxoEnvio.integ.test.mjs.');
  process.exit(0);
}

let mongod;
try {
  mongod = await MongoMemoryServer.create();
} catch (e) {
  console.log('⏭️  Pulando: mongod indisponível neste ambiente (download bloqueado). Rode na sua máquina. Detalhe:', (e.message || '').split('\n')[0]);
  process.exit(0);
}
await mongoose.connect(mongod.getUri());

let passed = 0, failed = 0;
try {
  const now = Date.now();
  const d = (dias) => new Date(now - dias * 86400000);
  const base = { title: 't', content: 'c', theme: 'fonoaudiologia', nextRetryAt: null };

  // timestamps:false para conseguir fixar createdAt (senão o mongoose sobrescreve)
  await GmbPost.insertMany([
    { ...base, _id: new mongoose.Types.ObjectId(), status: 'scheduled',    mediaUrl: 'https://cdn/novo.jpg', scheduledAt: d(0.2), createdAt: d(0.2), updatedAt: d(0.2) }, // A: novo c/ imagem -> SELECIONA
    { ...base, _id: new mongoose.Types.ObjectId(), status: 'scheduled',    mediaUrl: null,                   scheduledAt: d(0.2), createdAt: d(0.2), updatedAt: d(0.2) }, // C: recente sem imagem
    { ...base, _id: new mongoose.Types.ObjectId(), status: 'scheduled',    mediaUrl: 'https://cdn/julho.jpg',scheduledAt: d(120), createdAt: d(120), updatedAt: d(120) }, // D: histórico jul c/ imagem
    { ...base, _id: new mongoose.Types.ObjectId(), status: 'unconfirmed',  mediaUrl: 'https://cdn/x.jpg',    scheduledAt: d(0.2), createdAt: d(0.2), updatedAt: d(0.2) }, // E: já enviado
    { ...base, _id: new mongoose.Types.ObjectId(), status: 'needs_review', mediaUrl: null,                   scheduledAt: d(0.2), createdAt: d(0.2), updatedAt: d(0.2) }, // B: sem imagem
    { ...base, _id: new mongoose.Types.ObjectId(), status: 'published',    mediaUrl: 'https://cdn/y.jpg',    scheduledAt: d(0.2), createdAt: d(0.2), updatedAt: d(0.2) }, // F: publicado
  ], { timestamps: false });

  const sel = await GmbPost.findScheduledForPublish(50);

  const t = (nome, cond) => { try { assert.ok(cond); console.log('✅', nome); passed++; } catch (e) { console.error('❌', nome); failed++; } };
  t('findScheduledForPublish retorna exatamente 1 post', sel.length === 1);
  t('é o post novo COM imagem', sel[0]?.mediaUrl === 'https://cdn/novo.jpg');
  t('nenhum selecionado sem imagem', sel.every(p => p.mediaUrl));
  t('histórico de julho NÃO entra (recência)', !sel.some(p => p.mediaUrl === 'https://cdn/julho.jpg'));
  t('unconfirmed/published/needs_review NÃO entram', sel.every(p => p.status === 'scheduled'));
} finally {
  console.log(`\n${passed} passaram, ${failed} falharam`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(failed ? 1 : 0);
}
