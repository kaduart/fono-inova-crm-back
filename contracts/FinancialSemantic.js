/**
 * 💰 Financial Semantic Constants
 *
 * Congela no código as definições oficiais de Caixa, Produção e Pipeline.
 * Qualquer novo aggregate, worker ou relatório DEVE usar estes campos.
 *
 * Referência: SEMANTICA_OFICIAL.md
 */

export const SEMANTIC = Object.freeze({
  // ─── Camadas Financeiras ───
  CASH: {
    field: 'cash.total',
    definition: 'Pagamentos com status = "paid". Regime de caixa real.',
    query: { status: 'paid', amount: { $gt: 0 }, kind: { $ne: 'package_consumed' } },
    source: 'Payment',
  },
  PRODUCTION: {
    field: 'revenue.total',
    definition: 'Sessões com status = "completed" + convênios completados. Regime de competência.',
    query: { status: 'completed' },
    source: 'Session',
  },
  PIPELINE: {
    field: 'aReceberProducao',
    definition: 'Pagamentos pendentes (status = "pending" ou "billed") que ainda serão recebidos.',
    query: { status: { $in: ['pending', 'billed'] } },
    source: 'Payment',
  },
  CAIXA_PROJETADO: {
    field: 'metas.camadas.caixaProjetado',
    definition: 'Caixa realizado + Pipeline (a receber). Informativo/liquidez apenas. NUNCA usa como meta.',
    formula: 'CASH + PIPELINE',
  },

  // ─── Métricas Derivadas ───
  RITMO: {
    field: 'metas.ritmo.mediaDiariaAtual',
    definition: 'Produção acumulada ÷ dias decorridos. Velocidade operacional real.',
    formula: 'PRODUCTION / diasDecorridos',
  },
  META: {
    field: 'metas.configuracao.metaMensal',
    definition: 'Meta principal = PRODUÇÃO (não caixa, não receita projetada).',
    base: 'PRODUCTION',
  },

  // ─── Projeções ───
  PROJECAO_ESPERADA: {
    field: 'metas.projecao.esperada',
    definition: 'Cenário conservador: realizada + 70% do pipeline + 60% da média nos dias restantes.',
    formula: 'PRODUCTION + (PIPELINE * 0.7) + (RITMO * diasRestantes * 0.6)',
  },
  PROJECAO_OTIMISTA: {
    field: 'metas.projecao.final',
    definition: 'Extrapolação linear pura: ritmo médio × dias no mês.',
    formula: 'RITMO * diasNoMes',
  },
});

// ─── Helpers de validação ───
export function validateSemanticConsistency(data) {
  const errors = [];

  if (data.cash?.total < 0) {
    errors.push('CAIXA não pode ser negativo');
  }
  if (data.revenue?.total < 0) {
    errors.push('PRODUÇÃO não pode ser negativa');
  }
  if (data.aReceberProducao < 0) {
    errors.push('PIPELINE não pode ser negativo');
  }

  // Regra: Caixa nunca pode ser maior que Produção + margem de tolerância
  // (exceto quando há retroativos significativos)
  if (data.cash?.total > (data.revenue?.total * 1.5)) {
    errors.push('CAIXA discrepante: maior que 150% da PRODUÇÃO (verificar retroativos)');
  }

  return errors;
}
