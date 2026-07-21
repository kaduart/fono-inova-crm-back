// adapters/fiscal/AnapolisMunicipalAdapter.js
// Municipal Adapter para o webservice PRÓPRIO de Anápolis-GO (operado tecnicamente por
// "NotaControl", suporte: suporte.anapolis@notacontrol.com.br — confirmado em
// anapolis_integration_status.md). Este é o adapter que a clínica REALMENTE precisa usar hoje
// (regime normal ou Simples Nacional antes de 01/09/2026) — mas a URL técnica de recepção de
// XML/DPS e o manual de integração correspondente NUNCA foram obtidos (lacuna #4 da Fase 1.5).
//
// Deliberadamente NÃO implementado com uma URL adivinhada — inventar um host aqui seria
// exatamente o tipo de suposição que este projeto decidiu, desde a Fase 1, nunca fazer. Todo
// método lança NOT_IMPLEMENTED com a ação concreta necessária para desbloquear.

import { FiscalProvider } from '../../fiscal-provider/FiscalProvider.js';

const BLOCKING_REASON =
  'ANAPOLIS_ENDPOINT_DESCONHECIDO: URL técnica do webservice municipal de Anápolis (NotaControl/ISSNET) ' +
  'ainda não foi obtida. Próximo passo: contatar suporte.anapolis@notacontrol.com.br ou a SEMEC ' +
  '(anapolis_integration_status.md, Seção "Implicação prática para o CRM") para obter o manual de ' +
  'integração antes de implementar este adapter.';

export class AnapolisMunicipalAdapter extends FiscalProvider {
  async submitDps(_signedDpsXml) {
    throw new Error(BLOCKING_REASON);
  }

  async queryByChave(_chaveAcesso) {
    throw new Error(BLOCKING_REASON);
  }

  async registerEvent(_chaveAcesso, _eventPayload) {
    throw new Error(BLOCKING_REASON);
  }

  async listEvents(_chaveAcesso) {
    throw new Error(BLOCKING_REASON);
  }

  async getDanfse(_chaveAcesso) {
    throw new Error(BLOCKING_REASON);
  }
}
