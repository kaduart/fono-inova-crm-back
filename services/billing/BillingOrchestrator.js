// services/billing/BillingOrchestrator.js
import insuranceBilling from './insuranceBilling.js';
import packageBilling from './packageBilling.js';
import individualBilling from './individualBilling.js';
import advanceBilling from './advanceBilling.js';

/**
 * 🎯 Billing Orchestrator
 *
 * Delegador central de faturamento.
 * Detecta tipo de cobrança e roteia para serviço especializado.
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
        return await advanceBilling.handleAdvancePayment(ctx, mongoSession);

      case 'package':
        return await packageBilling.handlePackageSession(ctx, mongoSession);

      case 'individual':
      case 'particular':
        return await individualBilling.handleIndividualSession(ctx, mongoSession);

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
