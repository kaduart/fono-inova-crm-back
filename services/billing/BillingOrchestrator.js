// services/billing/BillingOrchestrator.js
import insuranceBilling from './insuranceBilling.js';

/**
 * 🎯 Billing Orchestrator
 *
 * Delegador central de faturamento no fluxo canônico de CREATE.
 *
 * Responsabilidade:
 * - Detectar o tipo de cobrança a partir do payload.
 * - Roteiar apenas para handlers ativos e canônicos.
 *
 * Regras:
 * - Convênio é o único tipo atualmente roteado pelo orchestrator.
 * - Particular / pacote são tratados por appointmentHybridService.js.
 * - Pagamento antecipado é tratado por helpers/handleAdvancePayment.js
 *   (em transição para um command dedicado).
 *
 * Fluxo oficial: docs/architecture/CANONICAL_FLOW.md
 */
class BillingOrchestrator {

  /**
   * Processa criação de agendamento com lógica de faturamento apropriada
   *
   * @param {Object} ctx - Contexto do agendamento (req.body)
   * @param {ClientSession} [mongoSession=null] - Sessão MongoDB (opcional)
   * @returns {Promise<Object>} Resultado do service especializado
   */
  async handleBilling(ctx, mongoSession = null) {
    const type = this.detectBillingType(ctx);

    switch (type) {
      case 'insurance':
      case 'convenio':
        return await insuranceBilling.createInsuranceAppointment(ctx, mongoSession);

      case 'advance':
        throw new Error(
          `[BILLING_ORCHESTRATOR] Pagamento adiantado deve ser tratado pelo fluxo canônico ` +
          `(helpers/handleAdvancePayment.js em transição). Não roteie 'advance' pelo BillingOrchestrator.`
        );

      case 'package':
      case 'individual':
      case 'particular':
        throw new Error(
          `[BILLING_ORCHESTRATOR] Particular e pacote devem ser tratados por ` +
          `appointmentHybridService.create() no fluxo canônico. Não roteie '${type}' pelo BillingOrchestrator.`
        );

      default:
        throw new Error(`Tipo de faturamento não suportado: ${type}`);
    }
  }

  /**
   * Detecta tipo de faturamento baseado nos dados enviados
   *
   * @param {Object} ctx - Contexto do agendamento
   * @returns {string} Tipo detectado: 'insurance', 'advance', 'package', 'individual'
   */
  detectBillingType(ctx) {
    const {
      billingType,
      insuranceGuideId,
      insurance,
      isAdvancePayment,
      advanceSessions,
      serviceType
    } = ctx;

    // 1. Convênio
    if (billingType === 'insurance' ||
        billingType === 'convenio' ||
        insuranceGuideId ||
        insurance) {
      return 'insurance';
    }

    // 2. Pagamento adiantado
    if (isAdvancePayment || (advanceSessions && advanceSessions.length > 0)) {
      return 'advance';
    }

    // 3. Pacote
    if (serviceType === 'package_session') {
      return 'package';
    }

    // 4. Individual/Avulso (padrão)
    return 'individual';
  }
}

export default new BillingOrchestrator();
