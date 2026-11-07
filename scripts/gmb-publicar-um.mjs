/**
 * Publicação CONTROLADA de 1 post do GMB — validação da Fase 0.
 * NÃO publica nada sem a flag --confirmar. Carrega .env sem dependência externa.
 *
 * Uso (na pasta crm/back):
 *   node scripts/gmb-publicar-um.mjs --listar
 *       → lista posts que JÁ têm imagem (scheduled/needs_review/failed), pra você escolher 1 ID. NÃO envia.
 *   node scripts/gmb-publicar-um.mjs --criar [--max-reuse 60]
 *       → cria 1 post (serviço escolhe a especialidade). --max-reuse eleva o limite de reuso do ImageBank
 *         só nesta execução (default 15), pra achar imagem quando o banco está muito reusado. NÃO envia.
 *   node scripts/gmb-publicar-um.mjs --id <postId>
 *       → DRY-RUN: mostra o post e as validações. NÃO envia.
 *   node scripts/gmb-publicar-um.mjs --id <postId> --confirmar
 *       → ENVIA esse 1 post ao Make (publica no Google Business Profile). Marca publishing_retry.
 */
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const getVal = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

// 1) Carrega .env ANTES de importar os serviços (eles leem process.env na avaliação)
try {
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
} catch { /* se não houver .env, assume env já populado */ }

// Eleva o limite de reuso do ImageBank SÓ nesta execução, se pedido (antes de importar o serviço).
const maxReuse = getVal('--max-reuse');
if (maxReuse) { process.env.IMAGE_BANK_MAX_REUSE = String(parseInt(maxReuse, 10) || 60); }

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
  // --- LISTAR: candidatos reais (já têm imagem), sem depender de OpenAI/ImageBank ---
  if (has('--listar')) {
    const candidatos = await GmbPost.find({
      status: { $in: ['scheduled', 'needs_review', 'failed'] },
      mediaUrl: { $type: 'string', $ne: '' },
    }).sort({ createdAt: -1 }).limit(15);

    if (!candidatos.length) {
      console.log('⚠️ Nenhum post com imagem encontrado. Use --criar --max-reuse 60.');
      process.exit(0);
    }
    console.log(`📋 ${candidatos.length} post(s) COM imagem (mais recentes primeiro):\n`);
    for (const p of candidatos) {
      console.log(`• ${String(p._id)}  [${p.status}]  ${p.theme}  — ${(p.title || '').slice(0, 50)}`);
    }
    console.log('\n👉 Escolha 1 e valide:\n   node scripts/gmb-publicar-um.mjs --id <ID>            (dry-run)');
    console.log('   node scripts/gmb-publicar-um.mjs --id <ID> --confirmar  (publica ESSE 1)');
    process.exit(0);
  }

  // --- CRIAR: gera 1 post novo (serviço escolhe a especialidade) ---
  if (has('--criar')) {
    const r = await gmbService.createDailyPost({ generateImage: true, funnelStage: 'top', publishedBy: 'manual' });
    console.log('📝 Post criado:');
    console.log(JSON.stringify(resumo(r.post), null, 2));
    console.log('\n--- conteúdo ---\n' + (r.post.content || '').slice(0, 600));
    if (r.post.status === 'needs_review' || !r.post.mediaUrl) {
      console.log('\n⚠️ Sem imagem elegível (needs_review). A especialidade sorteada não tem imagem disponível.');
      console.log('   Opções: rode de novo (sorteia outra), use --max-reuse 60, OU use --listar e envie um post que já tem imagem.');
    } else {
      console.log(`\n✅ Pronto para validar. Revise e publique com:\n   node scripts/gmb-publicar-um.mjs --id ${r.post._id} --confirmar`);
    }
    process.exit(0);
  }

  const id = getVal('--id');
  if (!id) { console.error('Informe --listar | --criar [--max-reuse N] | --id <postId> [--confirmar]'); process.exit(1); }

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
  post.publishedBy = 'manual';
  await post.save();
  console.log('✅ Enviado. Confira no Make (Integration Webhooks → History) e no Google Business Profile.');
  console.log('   (status = publishing_retry até confirmação; com Make sem callback, verifique no Google.)');
} finally {
  await mongoose.disconnect();
}
