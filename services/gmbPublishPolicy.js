/**
 * Política de publicação do GMB (PURA, sem dependências) — fonte única do filtro do enviador.
 * Usada por models/GmbPost.js (findScheduledForPublish) e pelos testes isolados.
 */

/**
 * Query do que PODE ser publicado agora.
 *  - status 'scheduled'
 *  - já venceu o horário (scheduledAt <= now)
 *  - TEM imagem (mediaUrl string não-vazia) — destrava os posts novos
 *  - RECENTE (createdAt dentro de maxAgeDays) — PROTEGE o backlog histórico:
 *    posts COM imagem antigos (ex.: lote de jul/2026 preso em 'scheduled') NÃO publicam em massa
 *  - não está aguardando retry
 */
export function filtroScheduledForPublish(now = new Date(), { maxAgeDays = 4 } = {}) {
  const corte = new Date(now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000);
  return {
    status: 'scheduled',
    scheduledAt: { $lte: now },
    mediaUrl: { $type: 'string', $ne: '' },
    createdAt: { $gte: corte },
    $or: [{ nextRetryAt: null }, { nextRetryAt: { $lte: now } }],
  };
}

/** Espelha a guarda do makeService: só envia ao Make post com imagem válida. */
export function podeEnviarAoMake(post) {
  return !!(post && typeof post.mediaUrl === 'string' && post.mediaUrl !== '');
}

/**
 * Mini-matcher de query Mongo (só os operadores usados aqui) — permite que os testes
 * apliquem o filtro REAL a documentos sintéticos, sem banco de dados.
 */
export function matchFiltro(doc, query) {
  const getType = (v) => {
    if (v === null || v === undefined) return 'null';
    if (v instanceof Date) return 'date';
    return typeof v;
  };
  const cmp = (a, b) =>
    (a instanceof Date || b instanceof Date)
      ? new Date(a).getTime() - new Date(b).getTime()
      : (a < b ? -1 : a > b ? 1 : 0);
  const matchCond = (val, cond) => {
    if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
      return Object.entries(cond).every(([op, arg]) => {
        switch (op) {
          case '$lte': return val != null && cmp(val, arg) <= 0;
          case '$gte': return val != null && cmp(val, arg) >= 0;
          case '$lt':  return val != null && cmp(val, arg) < 0;
          case '$gt':  return val != null && cmp(val, arg) > 0;
          case '$ne':  return val !== arg;
          case '$eq':  return val === arg;
          case '$type': return getType(val) === arg;
          case '$exists': return (val !== undefined) === arg;
          default: return false;
        }
      });
    }
    return val === cond;
  };
  return Object.entries(query).every(([key, cond]) => {
    if (key === '$or') return cond.some((sub) => matchFiltro(doc, sub));
    if (key === '$and') return cond.every((sub) => matchFiltro(doc, sub));
    return matchCond(doc[key], cond);
  });
}
