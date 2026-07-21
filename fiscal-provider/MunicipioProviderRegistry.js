// fiscal-provider/MunicipioProviderRegistry.js
// Registro município (código IBGE) → provider padrão. Critério PRIMÁRIO de resolução
// (Fase 2 v3, Seção 4.3) — corrigido no review: não é o regime tributário que decide o sistema,
// é o município. Fonte: back/docs/nfse-fiscal-module/anapolis_integration_status.md.

import { FiscalProviderName } from '../constants/fiscalProviders.js';

// Código IBGE de Anápolis-GO confirmado em anapolis_integration_status.md
export const ANAPOLIS_IBGE_CODE = '5201108';

export const MUNICIPIO_PROVIDER_REGISTRY = {
  [ANAPOLIS_IBGE_CODE]: FiscalProviderName.ANAPOLIS_MUNICIPAL
};

/**
 * @param {string} municipioIBGE
 * @returns {string|null} nome do provider padrão para o município, ou null se não catalogado
 *   (nesse caso o FiscalProviderResolver assume Sefin Nacional — comportamento documentado na
 *   Fase 1 como default para "município sem sistema próprio conhecido")
 */
export function getDefaultProviderForMunicipio(municipioIBGE) {
  return MUNICIPIO_PROVIDER_REGISTRY[municipioIBGE] || null;
}
