/**
 * Classificador de modelo financeiro de Package.
 *
 * Existe porque `paymentType === 'full'` sozinho NÃO define comportamento —
 * pacotes liminar também usam paymentType='full', mas seguem uma regra
 * financeira totalmente diferente (pagamento judicial periódico +
 * reconhecimento de receita por sessão, via domain/liminar/recognizeRevenue.js).
 * Um script de auditoria que tratou liminar como prepaid gerou 17 falsos
 * positivos de "cobrança duplicada" num único paciente (ver investigação
 * do paciente 69bbf5d42d22a57a538ed310, 2026-07-07).
 *
 * Qualquer heurística financeira sobre Package DEVE passar por aqui primeiro.
 */

export const PACKAGE_FINANCIAL_MODEL = {
  JUDICIAL_LIMINAR: 'JUDICIAL_LIMINAR',
  CONVENIO: 'CONVENIO',
  PREPAID: 'PREPAID',
  PER_SESSION: 'PER_SESSION',
  OUTRO: 'OUTRO',
};

/**
 * @param {{ model?: string, paymentType?: string, type?: string }} pkg
 * @param {{ billingType?: string }} [appointment] - opcional, contexto adicional
 */
export function classifyPackageFinancialModel(pkg, appointment = {}) {
  if (!pkg) return PACKAGE_FINANCIAL_MODEL.OUTRO;

  if (pkg.model === 'liminar' || pkg.type === 'liminar') {
    return PACKAGE_FINANCIAL_MODEL.JUDICIAL_LIMINAR;
  }
  if (pkg.model === 'convenio' || pkg.type === 'convenio' || appointment.billingType === 'convenio') {
    return PACKAGE_FINANCIAL_MODEL.CONVENIO;
  }
  if (pkg.model === 'prepaid' || pkg.paymentType === 'full') {
    return PACKAGE_FINANCIAL_MODEL.PREPAID;
  }
  if (pkg.model === 'per_session' || pkg.paymentType === 'per-session') {
    return PACKAGE_FINANCIAL_MODEL.PER_SESSION;
  }
  return PACKAGE_FINANCIAL_MODEL.OUTRO;
}

/**
 * Heurísticas de duplicidade/prepaid só fazem sentido pra PREPAID.
 * Qualquer outro modelo deve pular a heurística — não é falso, é fora de escopo.
 */
export function skipsPrepaidDuplicateHeuristic(financialModel) {
  return financialModel !== PACKAGE_FINANCIAL_MODEL.PREPAID;
}
