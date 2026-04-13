// services/financialGuard/index.js
// 🛡️ Financial Guard - Centraliza regras financeiras críticas por tipo

import packageGuard from './guards/package.guard.js';
import particularGuard from './guards/particular.guard.js';

const guardMap = {
  package: packageGuard,
  particular: particularGuard,
  // 🔜 insurance: insuranceGuard (futuro)
  // 🔜 legal: legalGuard (futuro)
};

/**
 * Financial Guard - Executa regras financeiras por contexto e tipo
 * 
 * ⚠️ REGRAS:
 * - SEMPRE roda dentro da transaction
 * - NUNCA publica evento
 * - NUNCA chama worker externo
 * - SÓ mexer no banco (determinístico)
 */
class FinancialGuard {
  /**
   * Executa guard específico por billingType
   * 
   * @param {Object} params
   * @param {String} params.context - Contexto ('CANCEL_APPOINTMENT', 'COMPLETE_SESSION', etc)
   * @param {String} params.billingType - Tipo ('package', 'particular', 'insurance', 'legal')
   * @param {Object} params.payload - Dados específicos do contexto
   * @param {mongoose.ClientSession} params.session - Sessão MongoDB (obrigatório!)
   */
  static async execute({ context, billingType, payload, session }) {
    if (!session) {
      throw new Error('[FinancialGuard] session é obrigatória - guard deve rodar dentro de transaction');
    }

    const guard = guardMap[billingType];

    if (!guard) {
      console.warn(`[FinancialGuard] billingType não mapeado: ${billingType} (context: ${context})`);
      return { handled: false, reason: 'BILLING_TYPE_NOT_MAPPED' };
    }

    console.log(`[FinancialGuard] Executando ${billingType} para ${context}`);
    
    return guard.handle({ context, payload, session });
  }

  /**
   * Verifica se billingType tem guard implementado
   */
  static isSupported(billingType) {
    return billingType in guardMap;
  }
}

export default FinancialGuard;
