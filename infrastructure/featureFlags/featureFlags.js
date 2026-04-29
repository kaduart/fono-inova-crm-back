// infrastructure/featureFlags/featureFlags.js
/**
 * FEATURE FLAGS
 * 
 * Permite ativar/desativar funcionalidades em tempo real
 * sem deploy de código.
 */

// Configuração default
const DEFAULT_FLAGS = {
    USE_EVENT_DRIVEN_COMPLETE: process.env.USE_EVENT_DRIVEN_COMPLETE === 'true',
    USE_OUTBOX_PATTERN: process.env.USE_OUTBOX_PATTERN === 'true',
    ENABLE_BALANCE_WORKER: true,
    ENABLE_PAYMENT_WORKER: true,
    ENABLE_SYNC_WORKER: true,
    ENABLE_OUTBOX_WORKER: true,
    ROLLOUT_PERCENTAGE: parseInt(process.env.ROLLOUT_PERCENTAGE || '0'),
    // 💰 Ledger Financial View (V1 → V2)
    USE_LEDGER_FINANCIAL_VIEW: process.env.FF_FINANCIAL_LEDGER === 'true',
    FINANCIAL_LEDGER_PERCENTAGE: parseInt(process.env.FF_FINANCIAL_LEDGER_PERCENTAGE || '0'),
};

let flags = { ...DEFAULT_FLAGS };

export function isEnabled(flagName, context = {}) {
    if (flags[flagName] === true || flags[flagName] === false) {
        // Rollout porcentagem — suporta userId ou patientId
        const rolloutKey = context.userId || context.patientId;
        const rolloutPct = flagName === 'USE_LEDGER_FINANCIAL_VIEW' 
            ? (flags.FINANCIAL_LEDGER_PERCENTAGE || 0)
            : flags.ROLLOUT_PERCENTAGE;
        if (rolloutKey && rolloutPct > 0) {
            return isInRollout(rolloutKey, rolloutPct);
        }
        return flags[flagName];
    }
    return false;
}

export function setFlag(flagName, value) {
    flags[flagName] = value;
    console.log(`[FeatureFlag] ${flagName} = ${value}`);
}

export function getAllFlags() {
    return { ...flags };
}

function isInRollout(userId, percentage) {
    const hash = hashCode(userId.toString());
    const normalized = Math.abs(hash) % 100;
    return normalized < percentage;
}

function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash;
}

export function featureFlagMiddleware(req, res, next) {
    req.featureFlags = {
        isEnabled: (flagName) => isEnabled(flagName, { userId: req.user?._id })
    };
    next();
}
