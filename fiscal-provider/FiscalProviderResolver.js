// O resolver aplica ResolutionPolicy; datas legais pertencem à configuração.
import { FiscalProviderName } from '../constants/fiscalProviders.js';
import { getDefaultProviderForMunicipio } from './MunicipioProviderRegistry.js';
import { loadResolutionPolicies, matchResolutionPolicy } from './ResolutionPolicy.js';

export function resolveProviderName(fiscalProfile, { asOfDate = new Date(), policies = loadResolutionPolicies() } = {}) {
  const policy = matchResolutionPolicy(policies, fiscalProfile, asOfDate);
  return policy?.provider || getDefaultProviderForMunicipio(fiscalProfile.municipioIBGE) || FiscalProviderName.SEFIN_NACIONAL;
}
