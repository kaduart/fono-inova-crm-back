// services/billing/packageBilling.js

/**
 * 📦 Package Billing Service
 *
 * Placeholder para faturamento de pacotes.
 * TODO: Extrair lógica existente de routes/appointment.js (linhas 84-375)
 */
class PackageBillingService {

  /**
   * Manipula criação de sessão de pacote
   *
   * @param {Object} ctx - Contexto do agendamento
   * @param {ClientSession} [mongoSession] - Sessão MongoDB
   * @throws {Error} Não implementado - usar fluxo legado
   */
  async handlePackageSession(ctx, mongoSession) {
    throw new Error(
      `[FASE_2_PENDING] ${ctx.billingType || 'package'}: ` +
      `Mover código do fluxo legado para este handler. ` +
      `Contexto: ${JSON.stringify({ patientId: ctx.patientId, serviceType: ctx.serviceType, packageId: ctx.packageId })}`
    );
  }
}

export default new PackageBillingService();
