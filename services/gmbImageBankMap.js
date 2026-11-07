/**
 * Mapa ID do calendário -> chave base real do ImageBank + seleção PURA de imagem.
 * SEM dependências externas (testável isolado). Usado por gmbService.js.
 *
 * Contexto da regressão: o calendário usa especialidadeId específico
 * (ex.: 'fonoaudiologia_infantil_anapolis', 'avaliacao_neuropsicologica_anapolis'),
 * mas o ImageBank guarda por chave BASE (fonoaudiologia, terapia_ocupacional,
 * psicomotricidade, musicoterapia, psicopedagogia, autismo). Esse mismatch fazia o
 * reúso falhar -> post sem imagem -> enviador pulava.
 */

// Especialidades que REALMENTE têm imagem ativa no banco hoje.
export const BANCO_ESPECIALIDADES = [
  'fonoaudiologia', 'terapia_ocupacional', 'psicomotricidade',
  'musicoterapia', 'psicopedagogia', 'autismo',
];

/**
 * Mapeia um especialidadeId para a chave base COERENTE do banco.
 * Retorna null quando não há especialidade coerente com imagem (ex.: psicologia,
 * neuropsicologia, neuropediatria, fisioterapia) — o chamador trata como needs_review.
 * NUNCA devolve uma especialidade incoerente só para preencher a imagem.
 */
export function especialidadeBaseParaBanco(especialidadeId = '') {
  const s = String(especialidadeId).toLowerCase();
  if (/fono|fala|lingu|disfagia|gagueira|\bvoz\b/.test(s)) return 'fonoaudiologia';
  if (/terapia_ocupacional|ocupacional|sensorial|seletiv|alimentar/.test(s)) return 'terapia_ocupacional';
  if (/psicomotric|motricidade|motor|coordena/.test(s)) return 'psicomotricidade';
  if (/music/.test(s)) return 'musicoterapia';
  if (/psicopedag|aprendiz|escolar|dislex|leitura|alfabet/.test(s)) return 'psicopedagogia';
  if (/autis|\btea\b|espectro/.test(s)) return 'autismo';
  return null; // sem imagem coerente no banco -> needs_review
}

/**
 * Seleção PURA de imagem do banco, pela chave base.
 * `buscar(especialidade, tema, opts)` deve retornar {url,...}|null (ex.: findExistingImage).
 * NÃO gera imagem nem chama IA: só reutiliza o que já existe (respeita GMB_ALLOW_AI_IMAGES).
 * Retorna { url, publicId?, provider:'imagebank-base', reused:true, base } ou null.
 */
export async function buscarImagemBancoPorBase(especialidadeId, tema, buscar, opts = {}) {
  const base = especialidadeBaseParaBanco(especialidadeId);
  if (!base) return null;
  let img = tema ? await buscar(base, tema, opts) : null;
  if (!img) img = await buscar(base, '', opts);
  if (img && img.url) {
    return { url: img.url, publicId: img.publicId, provider: 'imagebank-base', reused: true, base };
  }
  return null;
}
