// scripts/seedImageBank.mjs
// Popula o ImageBank para especialidades com pouca/nenhuma cobertura, usando
// a cascata real de geração do GMB (HuggingFace FLUX grátis → fal.ai FLUX →
// Freepik AI). generateImageForEspecialidade já salva automaticamente no
// ImageBank ao gerar (HF/fal/Freepik) — isso só dispara N gerações por tema
// pra dar um empurrão inicial em vez de esperar o cron acumular organicamente.
//
// GOOGLE_AI_API_KEY (Gemini/Imagen) não foi usado aqui: a chave atual não tem
// cota gratuita de geração de imagem (429 RESOURCE_EXHAUSTED, limit:0, tanto
// em gemini-2.5-flash-image quanto gemini-3.1-flash-image) — precisa habilitar
// billing no Google AI Studio antes de virar uma opção viável.
//
// Rodar sob demanda: node --env-file=.env scripts/seedImageBank.mjs
// (--env-file evita a race de dotenv.config() com imports ESM hoisted, que
// fazem gmbService.js ler process.env.OPENAI_API_KEY antes do .env carregar)
import mongoose from 'mongoose';
import { generateImageForEspecialidade, ESPECIALIDADES } from '../services/gmbService.js';

const IMAGES_PER_THEME = Number(process.env.SEED_IMAGES_PER_THEME || 3);

// Temas alvo: cobertura zero ou quase zero no ImageBank hoje (levantado em 2026-08-17)
const TARGET_IDS = [
  'psicologia', 'neuropsicologia', 'fisioterapia', 'freio_lingual',
  'psicopedagogia_clinica', 'autismo', 'tdah', 'fono_adulto',
  'fonoaudiologia_anapolis', 'psicologia_infantil_anapolis',
  'terapia_ocupacional_anapolis', 'psicomotricidade_anapolis',
  'teste_da_linguinha_anapolis', 'fisioterapia_infantil_anapolis',
  'avaliacao_neuropsicologica_anapolis',
];

async function main() {
  const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 15000 });
  console.log('✅ MongoDB conectado');

  const results = { ok: 0, fail: 0, byProvider: {} };

  for (const id of TARGET_IDS) {
    const especialidade = ESPECIALIDADES.find(e => e.id === id);
    if (!especialidade) {
      console.warn(`⚠️ Especialidade não encontrada em ESPECIALIDADES: ${id} — pulando`);
      continue;
    }
    console.log(`\n=== ${id} (${IMAGES_PER_THEME} imagens) ===`);
    for (let i = 1; i <= IMAGES_PER_THEME; i++) {
      try {
        // forceNew: true pula o reúso do ImageBank de propósito — queremos
        // gerar conteúdo NOVO pra popular o banco, não reciclar o que já existe
        const result = await generateImageForEspecialidade(
          especialidade,
          especialidade.foco,
          false,
          'auto',
          { forceNew: true }
        );
        console.log(`  [${i}/${IMAGES_PER_THEME}] ✅ provider=${result?.provider} ${result?.url?.substring(0, 60)}...`);
        results.ok++;
        results.byProvider[result?.provider] = (results.byProvider[result?.provider] || 0) + 1;
      } catch (e) {
        console.error(`  [${i}/${IMAGES_PER_THEME}] ❌ ${e.message}`);
        results.fail++;
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.log(`\n=== RESUMO: ${results.ok} ok, ${results.fail} falharam ===`);
  console.log('Por provider:', JSON.stringify(results.byProvider));
  await mongoose.disconnect();
}

main().catch(e => {
  console.error('❌ Erro fatal:', e);
  process.exit(1);
});
