// services/billing/individualBilling.js

/**
 * 💵 Individual Billing Service
 *
 * Placeholder para faturamento individual/avulso.
 * TODO: Extrair lógica existente de routes/appointment.js (linhas 376-490)
 */
class IndividualBillingService {

  /**
   * Manipula criação de sessão individual/avulsa
   *
   * @param {Object} ctx - Contexto do agendamento
   * @param {ClientSession} [mongoSession] - Sessão MongoDB
   * @throws {Error} Não implementado - usar fluxo legado
   */
  async handleIndividualSession(ctx, mongoSession) {
    throw new Error(
      `[FASE_2_PENDING] ${ctx.billingType || 'individual'}: ` +
      `Mover código do fluxo legado para este handler. ` +
      `Contexto: ${JSON.stringify({ patientId: ctx.patientId, serviceType: ctx.serviceType })}`
    );
  }
}

export default new IndividualBillingService();
