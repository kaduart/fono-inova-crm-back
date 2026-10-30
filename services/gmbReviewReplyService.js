import { createHash } from 'node:crypto';

const normalize = (text) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const stars = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
const topics = [
  ['welcome', /acolh|aconcheg|segunda casa|carinho|carinh|atencios|atencao/, [
    'É muito bom saber que o acolhimento fez diferença na sua experiência.',
    'Seu reconhecimento ao cuidado e à atenção da equipe nos alegra.',
    'Ficamos felizes em saber que encontrou um ambiente acolhedor por aqui.',
  ]],
  ['team', /equipe|profission|qualific|competent|preparad|dedicad/, [
    'O reconhecimento à dedicação da nossa equipe nos deixa muito felizes.',
    'Que bom receber esse carinho pelo trabalho dos nossos profissionais.',
    'Sua mensagem é um incentivo especial para toda a nossa equipe.',
  ]],
  ['space', /ambiente|espaco|estrutura|ludic|completa|organiz|limp/, [
    'Que bom saber que o nosso espaço deixou uma impressão tão positiva.',
    'Ficamos felizes com seu reconhecimento ao ambiente da clínica.',
    'Preparamos nosso espaço com cuidado, e é uma alegria receber esse retorno.',
  ]],
];
const thanks = ['Agradecemos por compartilhar sua avaliação!', 'Muito obrigado pelo carinho nas suas palavras!', 'Sua avaliação é muito especial para nós. Obrigado!'];

/** Pure, deterministic and free of network, database or AI-provider calls. */
export function buildGmbReviewReply(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Corpo inválido');
  const { reviewId, comment = '', starRating, existingReply } = input;
  if (typeof reviewId !== 'string' || !reviewId.trim() || reviewId.length > 1024) throw new TypeError('reviewId obrigatório');
  if (typeof comment !== 'string' || comment.length > 10000) throw new TypeError('comment inválido');
  const rating = stars[starRating] ?? starRating;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new TypeError('starRating inválido');
  if (existingReply != null && typeof existingReply !== 'string') throw new TypeError('existingReply inválido');
  const skip = (reason) => ({ eligible: false, reply: null, reason, mode: 'rules', aiCost: 0 });
  if (existingReply?.trim()) return skip('already_replied');
  if (rating < 4) return skip('manual_review_rating');
  const text = normalize(comment);
  // High ratings can still contain complaints: no automatic upbeat response.
  if (/\b(nao|nunca|porem|mas|apesar|pena|infelizmente)\b|reclam|ruim|pessim|demor|atras|descaso|insatisf|problema|decepcion|cobranc|reembols|erro|errad|horriv|falta|melhorar/.test(text)) return skip('manual_review_comment');
  const seed = createHash('sha256').update(reviewId).digest();
  if (!comment.trim()) return { eligible: true, reply: ['Obrigado por deixar sua avaliação para a Clínica Fono Inova!', 'Agradecemos pelas estrelas e pelo tempo dedicado a nos avaliar!', 'Sua avaliação é muito bem-vinda. Muito obrigado!'][seed[0] % 3], reason: null, mode: 'rules', aiCost: 0 };
  const topic = topics.find(([, pattern]) => pattern.test(text));
  const opening = topic ? topic[2][seed[0] % 3] : ['É uma alegria receber uma mensagem tão gentil.', 'Ficamos felizes com seu retorno sobre a clínica.', 'Recebemos suas palavras com muito carinho.'][seed[0] % 3];
  return { eligible: true, reply: `${opening} ${thanks[seed[1] % 3]}`, reason: null, mode: 'rules', aiCost: 0 };
}
