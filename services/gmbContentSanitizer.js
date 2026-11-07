/**
 * 🧼 Higieniza o conteúdo de posts do GMB para publicação pública no Google.
 * Módulo PURO, sem dependências. Fonte ÚNICA de verdade — usado tanto no gerador
 * (services/gmbService.js → createDailyPost) quanto no script de correção pontual
 * (scripts/gmb-corrigir-um.mjs).
 *
 * Regras:
 *  - Remove do CORPO do texto: telefone, URLs e a linha de "Palavras-chave" (SEO interno).
 *    O link deve ir para o BOTÃO do post (ctaUrl/ctaType) — o Google penaliza telefone/URL no corpo.
 *  - Remove a claim "avaliação gratuita" (a avaliação é paga — R$220).
 *  - Corta frase final incompleta (parte do conteúdo legado foi salvo truncado no meio).
 */

const RE_FONE = /\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}/;              // (62) 99201-3573
const RE_URL  = /(https?:\/\/|www\.|clinicafonoinova\.com\.br|wa\.me)/i;
const RE_KW   = /palavras?\-?\s*chave/i;                          // linha de SEO interno

/** Extrai a 1ª URL do texto (para jogar no botão). Retorna null se não houver. */
export function extrairUrl(txt) {
  const m = (txt || '').match(/https?:\/\/[^\s)]+|(?:www\.)?clinicafonoinova\.com\.br\/[^\s)]+/i);
  if (!m) return null;
  let u = m[0].replace(/[.,;]+$/, '');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

/** Limpa o corpo do post conforme as regras acima. Idempotente. */
export function limparConteudoGmb(content) {
  const linhas = (content || '').split('\n');
  const mantidas = linhas.filter((l) => {
    if (RE_FONE.test(l)) return false;   // telefone fora do corpo
    if (RE_URL.test(l))  return false;   // URL fora do corpo
    if (RE_KW.test(l))   return false;   // "Palavras-chave" não é p/ paciente
    return true;
  });
  let out = mantidas.join('\n');
  out = out.replace(/avaliaç(?:ã|a)o\s+gratuita/gi, 'avaliação'); // tira claim falsa
  out = out.replace(/\n{3,}/g, '\n\n').trim();                    // normaliza linhas em branco
  // corta frase final incompleta (conteúdo legado às vezes foi salvo truncado no meio)
  if (!/[.!?…)]$/.test(out)) {
    const corte = Math.max(out.lastIndexOf('.'), out.lastIndexOf('!'), out.lastIndexOf('?'), out.lastIndexOf('…'));
    if (corte > 40) out = out.slice(0, corte + 1).trim();
  }
  return out;
}

/** Conveniência: devolve { content limpo, url extraída p/ o botão }. */
export function sanitizeGmbContent(content) {
  return { content: limparConteudoGmb(content), url: extrairUrl(content) };
}
