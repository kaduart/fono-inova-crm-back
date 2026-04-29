/**
 * 🎚️ Financial Feature Flag Middleware
 *
 * Permite rollout gradual V1 → V2 sem quebrar o frontend.
 *
 * Regras:
 * - Header `X-Financial-Version: v2` → força V2
 * - Header `X-Financial-Version: v1` → força V1 (default)
 * - Query `?financialVersion=v2` → força V2 (fallback para URL)
 * - User flag `user.financialVersion` → persiste preferência
 * - Global env `FINANCIAL_VERSION_DEFAULT=v2` → default global
 *
 * Estados:
 * - 'v1' → legacy (campos do documento)
 * - 'v2' → ledger (Payment-based)
 * - 'dual' → retorna ambos para comparação (modo auditoria)
 */

import User from '../models/User.js';
import { isEnabled } from '../infrastructure/featureFlags/featureFlags.js';

const GLOBAL_DEFAULT = process.env.FINANCIAL_VERSION_DEFAULT || 'v1';
const ALLOWED_VERSIONS = ['v1', 'v2', 'dual'];

export async function financialFeatureFlag(req, res, next) {
  try {
    let version = null;

    // 1. Header (prioridade mais alta)
    const headerVersion = req.headers['x-financial-version'];
    if (headerVersion && ALLOWED_VERSIONS.includes(headerVersion)) {
      version = headerVersion;
    }

    // 2. Query param
    if (!version) {
      const queryVersion = req.query.financialVersion;
      if (queryVersion && ALLOWED_VERSIONS.includes(queryVersion)) {
        version = queryVersion;
      }
    }

    // 3. User preference (persistida no banco)
    if (!version && req.user?._id) {
      const user = await User.findById(req.user._id).select('financialVersion');
      if (user?.financialVersion && ALLOWED_VERSIONS.includes(user.financialVersion)) {
        version = user.financialVersion;
      }
    }

    // 4. Feature flag global — se ledger desabilitado, força v1
    const ledgerEnabled = isEnabled('USE_LEDGER_FINANCIAL_VIEW', { userId: req.user?._id, patientId: req.params?.patientId });
    if (!ledgerEnabled && version === 'v2') {
      version = 'v1';
    }
    if (!ledgerEnabled && version === 'dual') {
      version = 'v1';
    }

    // 5. Global default
    if (!version) {
      version = ledgerEnabled ? GLOBAL_DEFAULT : 'v1';
    }

    // Attach ao request
    req.financialVersion = version;

    // Log para auditoria
    if (version === 'v2' || version === 'dual') {
      console.log(`[FeatureFlag] User ${req.user?._id} using financialVersion=${version}`, {
        path: req.path,
        method: req.method,
        source: headerVersion ? 'header' : req.query.financialVersion ? 'query' : req.user?._id ? 'user' : 'global'
      });
    }

    next();
  } catch (err) {
    console.error('[FeatureFlag] Erro:', err);
    // Fallback seguro
    req.financialVersion = 'v1';
    next();
  }
}

/**
 * Helper para verificar se deve usar V2
 */
export function isV2(req) {
  return req.financialVersion === 'v2';
}

/**
 * Helper para verificar se deve usar modo dual
 */
export function isDual(req) {
  return req.financialVersion === 'dual';
}

/**
 * Helper para verificar se deve usar V1
 */
export function isV1(req) {
  return req.financialVersion === 'v1';
}

export default financialFeatureFlag;
