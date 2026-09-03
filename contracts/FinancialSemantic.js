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
  // Definições completas, matriz de eventos, regras e proibições:
  // back/docs/FINANCIAL_SOURCE_OF_TRUTH.md
  CASH: {
    field: 'cash.total',
    definition: 'Caixa Real: soma dos Payments efetivamente pagos (status="paid") no ' +
      'período, pela data financeira canônica (financialDate, fallback paidAt). Inclui ' +
      'recebimentos retroativos de convênio — o dinheiro entrou naquele mês, mesmo que ' +
      'a sessão seja de um mês anterior.',
    query: { status: 'paid', amount: { $gt: 0 }, kind: { $ne: 'package_consumed' } },
    source: 'Payment',
    dateField: 'financialDate (fallback: paidAt)',
  },
  PRODUCTION: {
    field: 'revenue.total',
    definition: 'Produção: valor dos atendimentos efetivamente realizados, baseado em ' +
      'Session.completed e no valor clínico canônico (resolveSessionFinancialValue). ' +
      'Regime de competência — não representa necessariamente dinheiro recebido.',
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
  CONVENIO_RETROATIVO: {
    field: 'metaRealizada.excluded.retroativoConvenio (calculateMetaRealizada) / metas.excluidoDaMeta.retroativoConvenio (dashboard)',
    definition: 'Pagamento de convênio recebido no mês consultado, referente a sessão ' +
      'realizada em mês anterior. Entra no Caixa Real (o dinheiro entrou); não entra na ' +
      'Meta Realizada (não é receita nova do mês). Classificado por Payment individual ' +
      '(nunca por lote/NF inteira) via competência: Payment.serviceDate, com fallback ' +
      'Appointment.date → Session.date quando serviceDate está ausente.',
    source: 'Payment (billingType=convenio ou paymentMethod=convenio)',
  },

  // ─── Métricas Derivadas ───
  RITMO: {
    field: 'metas.ritmo.mediaDiariaAtual',
    definition: 'Meta Realizada acumulada ÷ dias decorridos. Velocidade operacional real.',
    formula: 'META / diasDecorridos',
  },
  // base mudou de PRODUCTION para CASH_MINUS_RETROATIVO em 2026-09-03 —
  // decisão de negócio deliberada, não desvio acidental. Definição completa,
  // matriz de eventos, proibições e testes: back/docs/FINANCIAL_SOURCE_OF_TRUTH.md
  // → "Meta Realizada".
  META: {
    field: 'metas.configuracao.metaMensal (meta configurada) / metas.realizado.mes (valor realizado)',
    definition: 'Meta Realizada = Caixa Real MENOS Convênio Retroativo MENOS Liminar. ' +
      'Venda de pacote entra integralmente no momento do pagamento, mesmo cobrindo ' +
      'sessões futuras; consumo posterior do saldo não gera Meta Realizada nova. ' +
      'Convênio só entra quando realizado E recebido no mesmo mês. Convênio sem ' +
      'competência determinável nunca é tratado como mês atual por omissão de dado. ' +
      'Calculada exclusivamente no backend — nunca no frontend, nunca por resíduo ' +
      '(caixa − produção) e nunca por lote/NF inteira.',
    base: 'CASH_MINUS_RETROATIVO',
    formula: 'CASH − CONVENIO_RETROATIVO − LIMINAR',
    source: 'unifiedFinancialService.v2.js → calculateMetaRealizada()',
  },

  // ─── Projeções ───
  PROJECAO_ESPERADA: {
    field: 'metas.projecao.esperada',
    definition: 'Cenário conservador: Meta Realizada + 70% do pipeline + 60% da média nos dias restantes.',
    formula: 'META + (PIPELINE * 0.7) + (RITMO * diasRestantes * 0.6)',
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
