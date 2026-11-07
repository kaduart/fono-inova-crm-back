/**
 * Publicação CONTROLADA de 1 post do GMB — validação da Fase 0.
 * NÃO publica nada sem a flag --confirmar. Carrega .env sem dependência externa.
 *
 * Uso (na pasta crm/back):
 *   node scripts/gmb-publicar-um.mjs --criar
 *       → cria 1 post (deixa o serviço escolher a especialidade), mostra ID/status/imagem/conteúdo. NÃO envia.
 *   node scripts/gmb-publicar-um.mjs --id <postId>
 *       → DRY-RUN: mostra o post e as validações. NÃO envia.
 *   node scripts/gmb-publicar-um.mjs --id <postId> --confirmar
 *       → ENVIA esse 1 post ao Make (publica no Google Business Profile). Marca publishing_retry.
 */
import { readFileSync } from 'node:fs';

// 1) Carrega .env ANTES de importar os serviços (eles leem process.env na avaliação)
try {
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
} catch { /* se não houver .env, assume env já populado */ }

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const getVal = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const mongoose = (await import('mongoose')).default;
const { default: GmbPost } = await import('../models/GmbPost.js');
const gmbService = await import('../services/gmbService.js');
const makeService = await import('../services/makeService.js');

const resumo = (p) => ({
  id: String(p._id), status: p.status, theme: p.theme,
  temImagem: !!p.mediaUrl, mediaUrl: p.mediaUrl ? p.mediaUrl.slice(0, 70) + '...' : null,
  title: p.title, scheduledAt: p.scheduledAt,
});

await mongoose.connect(process.env.MONGO_URI);
try {
  if (has('--criar')) {
    const r = await gmbService.createDailyPost({ generateImage: true, funnelStage: 'top', publishedBy: 'validacao-controlada' });
    console.log('📝 Post criado:');
    console.log(JSON.stringify(resumo(r.post), null, 2));
    console.log('\n--- conteúdo ---\n' + (r.post.content || '').slice(0, 600));
    if (r.post.status === 'needs_review') console.log('\n⚠️ Sem imagem elegível (needs_review) — escolha outro ou rode de novo até sair um com imagem.');
    else console.log(`\n✅ Pronto para validar. Revise e publique com:\n   node scripts/gmb-publicar-um.mjs --id ${r.post._id} --confirmar`);
    process.exit(0);
  }

  const id = getVal('--id');
  if (!id) { console.error('Informe --criar OU --id <postId> [--confirmar]'); process.exit(1); }

  const post = await GmbPost.findById(id);
  if (!post) { console.error('Post não encontrado:', id); process.exit(1); }
  console.log('🔎 Post:', JSON.stringify(resumo(post), null, 2));
  console.log('\n--- conteúdo ---\n' + (post.content || '').slice(0, 600));

  if (!post.mediaUrl) { console.error('\n❌ Post SEM imagem — não publicar. Abortado.'); process.exit(1); }

  if (!has('--confirmar')) {
    console.log('\n🧪 DRY-RUN (nada enviado). Para publicar de verdade, repita com --confirmar.');
    process.exit(0);
  }

  console.log('\n🚀 Enviando ESTE post ao Make (publica no Google)...');
  await makeService.sendPostToMake(post);
  post.status = 'publishing_retry';
  post.nextRetryAt = new Date(Date.now() + 40 * 60 * 1000);
  post.publishedBy = 'validacao-controlada';
  await post.save();
  console.log('✅ Enviado. Confira no Make (Integration Webhooks → History) e no Google Business Profile.');
  console.log('   (status = publishing_retry até confirmação; com Make sem callback, verifique no Google.)');
} finally {
  await mongoose.disconnect();
}
