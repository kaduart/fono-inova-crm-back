/**
 * 💰 resolveSessionFinancialValue
 *
 * FONTE ÚNICA DE VERDADE para valuation de sessão.
 *
 * Hierarquia de valuation (MAIS ESPECÍFICO → MAIS GENÉRICO):
 *   1. package.sessionValue   (valor unitário explícito do pacote)
 *   2. package.totalValue / package.totalSessions  (prorata quando não há unitário)
 *   3. session.sessionValue   (valor avulso da própria sessão)
 *   4. 0                      (fallback de segurança)
 *
 * REGRAS:
 *   - Nunca retorna negativo
 *   - Arredonda para inteiro no cálculo prorata (mesma regra do cashflow diário)
 *   - Funciona tanto com objetos Mongoose populados quanto plain objects
 *
 * @param {Object} session - objeto Session (deve ter sessionValue e/ou package populado)
 * @returns {number} valor financeiro da sessão
 */
export function resolveSessionFinancialValue(session) {
  if (!session) return 0;

  const pkg = session.package || session._pkg?.[0] || null;

  // 1. package.sessionValue explícito
  if (pkg?.sessionValue > 0) {
    return Math.round(pkg.sessionValue);
  }

  // 2. Prorata a partir de totalValue / totalSessions
  const totalValue = pkg?.totalValue ?? 0;
  const totalSessions = pkg?.totalSessions ?? 0;
  if (totalValue > 0 && totalSessions > 0) {
    return Math.round(totalValue / totalSessions);
  }

  // 3. session.sessionValue avulso
  const sessionValue = session.sessionValue ?? session.value ?? 0;
  if (sessionValue > 0) {
    return Math.round(sessionValue);
  }

  // 4. Fallback seguro
  return 0;
}

/**
 * Versão para uso em aggregation pipelines (MongoDB).
 *
 * Retorna um array de estágios MongoDB que adiciona o campo `effectiveValue`
 * à pipeline, usando a MESMA hierarquia da função JS.
 *
 * Requer que a pipeline já tenha feito $lookup para a coleção 'packages'
 * (ou que o documento já tenha `_pkg` disponível).
 *
 * Uso:
 *   const stages = resolveSessionFinancialValueAggregate();
 *   Session.aggregate([ ...match, ...stages, { $group: { _id: null, total: { $sum: '$effectiveValue' } } }]);
 *
 * @returns {Array<Object>} estágios de aggregation MongoDB
 */
export function resolveSessionFinancialValueAggregate() {
  return [
    {
      $addFields: {
        _pkgSessionValue: { $arrayElemAt: ['$_pkg.sessionValue', 0] },
        _pkgTotalValue: { $arrayElemAt: ['$_pkg.totalValue', 0] },
        _pkgTotalSessions: { $arrayElemAt: ['$_pkg.totalSessions', 0] },
      },
    },
    {
      $addFields: {
        effectiveValue: {
          $cond: {
            if: {
              $and: [
                { $gt: [{ $size: { $ifNull: ['$_pkg', []] } }, 0] },
                { $gt: ['$_pkgSessionValue', 0] },
              ],
            },
            then: '$_pkgSessionValue',
            else: {
              $cond: {
                if: {
                  $and: [
                    { $gt: ['$_pkgTotalValue', 0] },
                    { $gt: ['$_pkgTotalSessions', 0] },
                  ],
                },
                then: { $round: [{ $divide: ['$_pkgTotalValue', '$_pkgTotalSessions'] }, 0] },
                else: { $ifNull: ['$sessionValue', 0] },
              },
            },
          },
        },
      },
    },
  ];
}
