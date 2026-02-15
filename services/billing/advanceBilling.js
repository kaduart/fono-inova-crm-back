// services/billing/advanceBilling.js

/**
 * 💰 Advance Billing Service
 *
 * Placeholder para pagamento adiantado.
 * TODO: Refatorar handleAdvancePayment (helper) para seguir padrão do módulo
 */
class AdvanceBillingService {

  /**
   * Manipula pagamento adiantado
   *
   * @param {Object} ctx - Contexto do agendamento
   * @param {ClientSession} [mongoSession] - Sessão MongoDB
   * @throws {Error} Não implementado - usar helper existente
   */
  async handleAdvancePayment(ctx, mongoSession) {
    throw new Error(
      `[FASE_2_PENDING] ${ctx.billingType || 'advance'}: ` +
      `Mover código do fluxo legado (handleAdvancePayment) para este handler. ` +
      `Contexto: ${JSON.stringify({ patientId: ctx.patientId, advanceSessions: ctx.advanceSessions?.length || 0 })}`
    );
  }
}

export default new AdvanceBillingService();
