/**
 * 📋 FINANCIAL REPORT CONTRACT
 *
 * Estrutura padronizada de resposta para TODOS os endpoints financeiros.
 *
 * REGRA DE OURO:
 *   Todo endpoint que retorne dados financeiros (caixa, produção, etc.)
 *   DEVE retornar um objeto que seja compatível com este contrato.
 *
 * Campos legados podem ser mantidos como aliases (ex: `recebido` apontando
 * para `producaoLiquidada`) para compatibilidade com frontends antigos,
 * mas o contrato oficial é a fonte de verdade para novos consumidores.
 */

/**
 * @typedef {Object} CaixaBlock
 * @property {number} total
 * @property {number} particular
 * @property {number} pacote
 * @property {number} convenio
 * @property {number} liminar
 * @property {Object} byMethod — { pix, dinheiro, cartao, outros }
 */

/**
 * @typedef {Object} ProducaoBlock
 * @property {number} totalProduzido    — valor total de sessões completadas
 * @property {number} producaoLiquidada — produção com cobertura financeira garantida
 * @property {number} pendente          — produção realizada mas não paga
 * @property {number} convenio          — produção convênio (realizada, aguardando repasse)
 * @property {number} particular
 * @property {number} pacote
 * @property {number} liminar
 */

/**
 * @typedef {Object} DiferidoBlock
 * @property {number} totalVendido   — total de pacotes vendidos no período
 * @property {number} totalConsumido — valor de sessões consumidas de pacotes pré-pagos
 * @property {number} saldo          — totalVendido - totalConsumido (receita diferida)
 */

/**
 * @typedef {Object} IndicadoresBlock
 * @property {number} taxaLiquidacao      — producaoLiquidada / totalProduzido (%)
 * @property {number} taxaInadimplencia   — pendente / totalProduzido (%)
 * @property {number} ticketMedio         — totalProduzido / quantidadeAtendimentos
 * @property {number} quantidadeAtendimentos
 */

/**
 * @typedef {Object} PeriodoBlock
 * @property {Date} inicio
 * @property {Date} fim
 * @property {string} timezone
 */

/**
 * @typedef {Object} FinancialReport
 * @property {CaixaBlock} caixa
 * @property {ProducaoBlock} producao
 * @property {DiferidoBlock} [diferido]
 * @property {IndicadoresBlock} indicadores
 * @property {PeriodoBlock} periodo
 */

// ═══════════════════════════════════════════════════════════════
// Builders — funções factory para garantir que todo endpoint
// construa respostas no mesmo formato.
// ═══════════════════════════════════════════════════════════════

export function buildCaixaBlock({ total = 0, particular = 0, pacote = 0, convenio = 0, liminar = 0, byMethod = {} } = {}) {
  return {
    total: Math.round(total * 100) / 100,
    particular: Math.round(particular * 100) / 100,
    pacote: Math.round(pacote * 100) / 100,
    convenio: Math.round(convenio * 100) / 100,
    liminar: Math.round(liminar * 100) / 100,
    byMethod: {
      pix: byMethod.pix || 0,
      dinheiro: byMethod.dinheiro || 0,
      cartao: byMethod.cartao || 0,
      outros: byMethod.outros || 0,
    },
  };
}

export function buildProducaoBlock({
  totalProduzido = 0,
  producaoLiquidada = 0,
  pendente = 0,
  convenio = 0,
  particular = 0,
  pacote = 0,
  liminar = 0,
} = {}) {
  return {
    totalProduzido: Math.round(totalProduzido * 100) / 100,
    producaoLiquidada: Math.round(producaoLiquidada * 100) / 100,
    pendente: Math.round(pendente * 100) / 100,
    convenio: Math.round(convenio * 100) / 100,
    particular: Math.round(particular * 100) / 100,
    pacote: Math.round(pacote * 100) / 100,
    liminar: Math.round(liminar * 100) / 100,
    // Aliases legados (não removidos para compatibilidade)
    get recebido() { return this.producaoLiquidada; },
    get total() { return this.totalProduzido; },
  };
}

export function buildDiferidoBlock({ totalVendido = 0, totalConsumido = 0 } = {}) {
  const saldo = totalVendido - totalConsumido;
  return {
    totalVendido: Math.round(totalVendido * 100) / 100,
    totalConsumido: Math.round(totalConsumido * 100) / 100,
    saldo: Math.round(saldo * 100) / 100,
  };
}

export function buildIndicadoresBlock({
  totalProduzido = 1,
  producaoLiquidada = 0,
  pendente = 0,
  quantidadeAtendimentos = 0,
} = {}) {
  const denominador = totalProduzido || 1;
  return {
    taxaLiquidacao: parseFloat(((producaoLiquidada / denominador) * 100).toFixed(1)),
    taxaInadimplencia: parseFloat(((pendente / denominador) * 100).toFixed(1)),
    ticketMedio: quantidadeAtendimentos > 0
      ? parseFloat((totalProduzido / quantidadeAtendimentos).toFixed(2))
      : 0,
    quantidadeAtendimentos,
  };
}

export function buildPeriodoBlock({ inicio, fim, timezone = 'America/Sao_Paulo' } = {}) {
  return { inicio, fim, timezone };
}

/**
 * Constrói o relatório financeiro completo a partir de blocos parciais.
 *
 * @param {Object} params
 * @returns {FinancialReport}
 */
export function buildFinancialReport({ caixa, producao, diferido, indicadores, periodo } = {}) {
  return {
    caixa: buildCaixaBlock(caixa),
    producao: buildProducaoBlock(producao),
    diferido: diferido ? buildDiferidoBlock(diferido) : undefined,
    indicadores: buildIndicadoresBlock(indicadores || producao),
    periodo: buildPeriodoBlock(periodo),
  };
}
