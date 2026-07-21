// fiscal-provider/FiscalProviderResolver.js
// Critério de resolução corrigido no review (Fase 2 v3, Seção 4.3):
//   1º: MUNICÍPIO decide o sistema técnico padrão (MunicipioProviderRegistry).
//   2º: REGIME TRIBUTÁRIO + DATA decidem exceções dentro daquele município — não o contrário.
// Isso porque um município pode migrar inteiro para o Ambiente Nacional amanhã, e essa mudança
// não deve depender do regime de nenhum contribuinte específico.
//
// Regra de migração conhecida hoje (fonte: anapolis_integration_status.md, Seção 3): em
// Anápolis, contribuintes do Simples Nacional migram para o Ambiente Nacional a partir de
// 01/09/2026; regime normal (Lucro Presumido/Real) permanece no webservice municipal sem
// previsão. MEI já usa o Ambiente Nacional desde a adoção do padrão nacional.

import { FiscalProviderName } from '../constants/fiscalProviders.js';
import { RegimeTributario } from '../constants/fiscalEnums.js';
import { ANAPOLIS_IBGE_CODE, getDefaultProviderForMunicipio } from './MunicipioProviderRegistry.js';

const MUNICIPIO_MIGRATION_RULES = {
  [ANAPOLIS_IBGE_CODE]: {
    regime: RegimeTributario.SIMPLES_NACIONAL,
    migratesTo: FiscalProviderName.SEFIN_NACIONAL,
    effectiveFrom: new Date('2026-09-01T00:00:00Z')
  }
};

/**
 * @param {{ municipioIBGE: string, regimeTributario: string }} fiscalProfile
 * @param {{ asOfDate?: Date }} [options]
 * @returns {string} nome do provider (constants/fiscalProviders.js)
 */
export function resolveProviderName(fiscalProfile, { asOfDate = new Date() } = {}) {
  const baseProvider = getDefaultProviderForMunicipio(fiscalProfile.municipioIBGE) || FiscalProviderName.SEFIN_NACIONAL;

  const migrationRule = MUNICIPIO_MIGRATION_RULES[fiscalProfile.municipioIBGE];
  if (
    migrationRule &&
    fiscalProfile.regimeTributario === migrationRule.regime &&
    asOfDate >= migrationRule.effectiveFrom
  ) {
    return migrationRule.migratesTo;
  }

  return baseProvider;
}
