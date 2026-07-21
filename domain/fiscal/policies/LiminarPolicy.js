// domain/fiscal/policies/LiminarPolicy.js
// Decide qual dos dois mecanismos oficiais (Fase 2, Seção 6) uma FiscalInvoice de origem
// `liminar` deve usar — NUNCA inferido automaticamente de Package.type === 'liminar'
// (invariante #9). Exige um campo explícito informado por decisão administrativa.
//
// Decisão em aberto (Fase 2, Seção 12, item 3): onde mora essa decisão a montante (candidato:
// TherapeuticPlan) ainda não foi definida — por isso esta policy recebe o dado já resolvido
// (`liminarFlow` + `hasMunicipalAuthorization`) em vez de resolvê-lo sozinha.

import { LiminarFlow } from '../../../constants/fiscalEnums.js';

/**
 * @param {{ liminarFlow: string, hasMunicipalAuthorization?: boolean }} input
 * @returns {{ proceed: boolean, reasons: string[] }}
 */
export function decideLiminarFlow({ liminarFlow, hasMunicipalAuthorization }) {
  if (!liminarFlow || liminarFlow === LiminarFlow.NONE) {
    return { proceed: true, reasons: [] };
  }

  if (liminarFlow === LiminarFlow.TAX_SUSPENSION) {
    // Fluxo regular de DPS com exigSusp/tpSusp — não exige autorização municipal prévia
    // (Fase 1.5, dps_field_matrix.md Seção 2.7)
    return { proceed: true, reasons: [] };
  }

  if (liminarFlow === LiminarFlow.JUDICIAL_BYPASS) {
    // POST /decisao-judicial/nfse exige autorização municipal prévia cadastrada na plataforma
    // (Fase 1, Seção 3.4/8) — nunca assumir que existe, precisa vir confirmado explicitamente.
    if (hasMunicipalAuthorization !== true) {
      return { proceed: false, reasons: ['JUDICIAL_BYPASS_SEM_AUTORIZACAO_MUNICIPAL_CONFIRMADA'] };
    }
    return { proceed: true, reasons: [] };
  }

  return { proceed: false, reasons: ['LIMINAR_FLOW_DESCONHECIDO'] };
}
