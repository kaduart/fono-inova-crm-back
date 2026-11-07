/**
 * Correção CIRÚRGICA de 1 post do GMB (para validação limpa da Fase 0).
 * Opera no conteúdo REAL do banco — não reescreve o texto do zero.
 * Remove do CORPO: telefone, URLs e a linha de "Palavras-chave" (SEO interno),
 * e tira a claim "avaliação gratuita". O link vai para o BOTÃO (ctaUrl/ctaType).
 *
 * Uso (na pasta crm/back):
 *   node scripts/gmb-corrigir-um.mjs --id <postId>            → mostra ANTES/DEPOIS. NÃO salva.
 *   node scripts/gmb-corrigir-um.mjs --id <postId> --salvar   → aplica a correção nesse 1 post.
 */
import { readFileSync } from 'node:fs';

try {
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
} catch { /* .env opcional */ }

const args = process.argv.slice(2);
const getVal = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const id = getVal('--id');
if (!id) { console.error('Informe --id <postId> [--salvar]'); process.exit(1); }

const mongoose = (await import('mongoose')).default;
const { default: GmbPost } = await import('../models/GmbPost.js');
// Mesma limpeza usada pelo gerador (createDailyPost) — fonte única de verdade.
const { limparConteudoGmb, extrairUrl } = await import('../services/gmbContentSanitizer.js');

await mongoose.connect(process.env.MONGO_URI);
try {
  const post = await GmbPost.findById(id);
  if (!post) { console.error('Post não encontrado:', id); process.exit(1); }

  const antes = post.content || '';
  const depois = limparConteudoGmb(antes);
  const urlBotao = extrairUrl(antes);

  console.log('===== ANTES =====\n' + antes);
  console.log('\n===== DEPOIS =====\n' + depois);
  console.log('\n===== BOTÃO (CTA) =====');
  console.log('ctaType :', urlBotao ? 'LEARN_MORE' : (post.ctaType || 'CALL'));
  console.log('ctaUrl  :', urlBotao || post.ctaUrl || '(mantém o atual)');

  if (!args.includes('--salvar')) {
    console.log('\n🧪 DRY-RUN (nada salvo). Repita com --salvar para aplicar.');
    process.exit(0);
  }

  post.content = depois;
  if (urlBotao) { post.ctaUrl = urlBotao; post.ctaType = 'LEARN_MORE'; }
  await post.save();
  console.log('\n✅ Post corrigido e salvo (status segue', post.status + ').');
  console.log('   Agora valide o envio:\n   node scripts/gmb-publicar-um.mjs --id ' + id + ' --confirmar');
} finally {
  await mongoose.disconnect();
}
