import { readFileSync } from 'node:fs';
import { FiscalProviderName } from '../constants/fiscalProviders.js';
import { RegimeTributario } from '../constants/fiscalEnums.js';

// Configuração externa opcional, sem datas legais dentro do resolver.
export function loadResolutionPolicies() {
  const path = process.env.FISCAL_RESOLUTION_POLICY_FILE || new URL('./resolution-policies.json', import.meta.url);
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function matchResolutionPolicy(policies, profile, asOfDate) {
  const instant = new Date(asOfDate).getTime();
  if (!Number.isFinite(instant) || !Array.isArray(policies)) throw new Error('FISCAL_RESOLUTION_POLICY_INVALID');
  const matches = [];
  for (const policy of policies) {
    const boundary = (value, fallback) => {
      if (value === null) return fallback;
      if (typeof value !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error('FISCAL_RESOLUTION_POLICY_INVALID_DATE');
      const parsed = Date.parse(value);
      if (!Number.isFinite(parsed)) throw new Error('FISCAL_RESOLUTION_POLICY_INVALID_DATE');
      return parsed;
    };
    const from = boundary(policy.effectiveFrom, -Infinity);
    const until = boundary(policy.effectiveUntil, Infinity);
    if (!/^\d{7}$/.test(policy.municipioIBGE) || !Object.values(RegimeTributario).includes(policy.regimeTributario) ||
        !Object.values(FiscalProviderName).includes(policy.provider) || from > until) throw new Error('FISCAL_RESOLUTION_POLICY_INVALID');
    if (policy.municipioIBGE === profile.municipioIBGE && policy.regimeTributario === profile.regimeTributario && instant >= from && instant <= until) matches.push(policy);
  }
  if (matches.length > 1) throw new Error('FISCAL_RESOLUTION_POLICY_AMBIGUOUS');
  return matches[0] || null;
}
