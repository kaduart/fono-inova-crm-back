// fiscal-provider/FiscalProvider.js
// Contrato único que o Fiscal Domain conhece (Fase 2 v3, Seção 1/4.1). Qualquer implementação
// concreta (Adapter) deve expor exatamente esta interface — o domínio nunca importa um Adapter
// diretamente.

export class FiscalProvider {
  /* eslint-disable no-unused-vars */

  /** @returns {Promise<{ success: boolean, xml?: string, fields?: object, error?: object }>} */
  async submitDps(signedDpsXml) {
    throw new Error('NOT_IMPLEMENTED: FiscalProvider.submitDps');
  }

  async queryByChave(chaveAcesso) {
    throw new Error('NOT_IMPLEMENTED: FiscalProvider.queryByChave');
  }

  async registerEvent(chaveAcesso, eventPayload) {
    throw new Error('NOT_IMPLEMENTED: FiscalProvider.registerEvent');
  }

  async listEvents(chaveAcesso) {
    throw new Error('NOT_IMPLEMENTED: FiscalProvider.listEvents');
  }

  async getDanfse(chaveAcesso) {
    throw new Error('NOT_IMPLEMENTED: FiscalProvider.getDanfse');
  }

  /* eslint-enable no-unused-vars */
}
