/**
 * 🛡️ AMANDA 4.2.1 - HARDENING DE PRODUÇÃO
 * =========================================
 * 
 * Blindagens para garantir que a máquina seja inquebrável:
 * 1. Cap de segurança no score
 * 2. TTL no MemoryWindow
 * 3. Anti-spam no Ghost Recovery
 * 4. Hysteresis no Closing Mode
 * 5. Logs estruturados de decisão
 */

import { trackDecision } from '../analytics/decisionTracking.js';

// ============================================================================
// 1. 🛡️ CAP DE SEGURANÇA NO INTENT SCORE
// ============================================================================

export const SCORE_CAP = { MIN: 0, MAX: 100 };
const SCORE_DEFAULTS = { FALLBACK: 50 };

/**
 * Aplica caps de segurança no score
 * @param {number} score - Score calculado
 * @returns {number} Score seguro
 */
export function safeScoreCap(score) {
    // Protege contra NaN, null, undefined
    if (!Number.isFinite(score)) {
        console.warn('[HARDENING] Score inválido detectado:', score);
        return SCORE_DEFAULTS.FALLBACK;
    }
    
    // Aplica caps
    return Math.max(SCORE_CAP.MIN, Math.min(SCORE_CAP.MAX, score));
}

/**
 * Valida estrutura do resultado de score
 * @param {Object} result - Resultado do cálculo
 * @returns {Object} Resultado validado
 */
export function validateScoreResult(result) {
    if (!result || typeof result !== 'object') {
        return {
            score: SCORE_DEFAULTS.FALLBACK,
            isHot: false,
            isWarm: true,
            isCold: false,
            error: 'invalid_result_structure'
        };
    }
    
    return {
        ...result,
        score: safeScoreCap(result.score),
        isHot: result.score >= 75,
        isWarm: result.score >= 40 && result.score < 75,
        isCold: result.score < 40
    };
}

// ============================================================================
// 2. 🛡️ TTL NO MEMORY WINDOW
// ============================================================================

export const MEMORY_TTL_HOURS = 24;

/**
 * Remove itens expirados da memory window
 * @param {Array} window - Janela de memória
 * @returns {Array} Janela limpa
 */
export function expireMemoryWindow(window = []) {
    if (!Array.isArray(window)) return [];
    
    const now = Date.now();
    const ttlMs = MEMORY_TTL_HOURS * 60 * 60 * 1000;
    
    return window.filter(item => {
        const itemTime = new Date(item.timestamp).getTime();
        const age = now - itemTime;
        
        if (age > ttlMs) {
            console.log(`[MEMORY_TTL] Removido: ${item.type} (${Math.round(age / 1000 / 60)}min)`);
            return false;
        }
        return true;
    });
}

/**
 * Verifica se item específico expirou
 * @param {Object} item - Item da memória
 * @returns {boolean} True se expirado
 */
export function isMemoryItemExpired(item) {
    if (!item?.timestamp) return true;
    
    const now = Date.now();
    const itemTime = new Date(item.timestamp).getTime();
    const ttlMs = MEMORY_TTL_HOURS * 60 * 60 * 1000;
    
    return (now - itemTime) > ttlMs;
}

/**
 * Limpa memória antiga antes de atualizar
 * @param {Array} window - Janela atual
 * @returns {Array} Janela limpa e pronta
 */
export function sanitizeMemoryWindow(window = []) {
    if (!Array.isArray(window)) return [];
    
    // Remove duplicados (mantém mais recente)
    const seen = new Map();
    window.forEach(item => {
        const existing = seen.get(item.type);
        if (!existing || new Date(item.timestamp) > new Date(existing.timestamp)) {
            seen.set(item.type, item);
        }
    });
    
    // Converte de volta para array e remove expirados
    const unique = Array.from(seen.values());
    return expireMemoryWindow(unique);
}

// ============================================================================
// 3. 🛡️ ANTI-SPAM NO GHOST RECOVERY
// ============================================================================

export const GHOST_LIMITS = {
    MAX_PER_12H: 1,
    MAX_PER_CONVERSATION: 2,
    MIN_MINUTES_BETWEEN: 60
};

/**
 * Verifica limites de ghost recovery
 * @param {Object} lead - Lead
 * @returns {Object} Status dos limites
 */
export function checkGhostLimits(lead) {
    const history = lead?.qualificationData?.ghostHistory || [];
    const now = Date.now();
    
    // Conta envios nas últimas 12h
    const twelveHoursAgo = now - (12 * 60 * 60 * 1000);
    const recentGhosts = history.filter(h => 
        new Date(h.sentAt).getTime() > twelveHoursAgo
    );
    
    // Verifica último envio
    const lastGhost = history[history.length - 1];
    const minutesSinceLast = lastGhost 
        ? (now - new Date(lastGhost.sentAt).getTime()) / (1000 * 60)
        : Infinity;
    
    const canSend = {
        allowed: true,
        reason: null,
        recentCount: recentGhosts.length,
        totalCount: history.length,
        minutesSinceLast
    };
    
    // Regra 1: Máximo 1 a cada 12h
    if (recentGhosts.length >= GHOST_LIMITS.MAX_PER_12H) {
        canSend.allowed = false;
        canSend.reason = 'limit_12h_reached';
        canSend.nextAvailable = new Date(twelveHoursAgo + (12 * 60 * 60 * 1000));
    }
    
    // Regra 2: Máximo 2 por conversa
    if (history.length >= GHOST_LIMITS.MAX_PER_CONVERSATION) {
        canSend.allowed = false;
        canSend.reason = 'limit_conversation_reached';
    }
    
    // Regra 3: Min 60min entre envios
    if (minutesSinceLast < GHOST_LIMITS.MIN_MINUTES_BETWEEN) {
        canSend.allowed = false;
        canSend.reason = 'cooldown_period';
        canSend.waitMinutes = Math.ceil(GHOST_LIMITS.MIN_MINUTES_BETWEEN - minutesSinceLast);
    }
    
    return canSend;
}

/**
 * Wrapper seguro para ghost recovery
 * @param {Object} lead - Lead
 * @param {Function} recoveryFn - Função de recuperação
 * @returns {Object|null} Mensagem ou null se bloqueado
 */
export function safeGhostRecovery(lead, recoveryFn) {
    const limits = checkGhostLimits(lead);
    
    if (!limits.allowed) {
        console.log(`[GHOST_LIMIT] Bloqueado: ${limits.reason}`, {
            leadId: lead._id,
            ...limits
        });
        return null;
    }
    
    return recoveryFn();
}

// ============================================================================
// 4. 🛡️ HYSTERESIS NO CLOSING MODE (Anti flip-flop)
// ============================================================================

export const MODE_THRESHOLDS = {
    CLOSING: { ENTER: 75, EXIT: 60 },
    WARMING: { ENTER: 40, EXIT: 30 },
    DISCOVERY: { ENTER: 0, EXIT: -1 } // Nunca sai do discovery para baixo
};

/**
 * Determina modo com hysteresis (evita oscilação)
 * @param {string} currentMode - Modo atual
 * @param {number} score - Score atual
 * @returns {string} Novo modo
 */
export function determineModeWithHysteresis(currentMode, score) {
    // Se já está em closing, só sai se cair abaixo de 60
    if (currentMode === 'closing') {
        if (score < MODE_THRESHOLDS.CLOSING.EXIT) {
            console.log(`[HYSTERESIS] Saindo de closing (${score} < ${MODE_THRESHOLDS.CLOSING.EXIT})`);
            return 'warming';
        }
        return 'closing';
    }
    
    // Se está em warming
    if (currentMode === 'warming') {
        // Sobe para closing
        if (score >= MODE_THRESHOLDS.CLOSING.ENTER) {
            console.log(`[HYSTERESIS] Entrando em closing (${score} >= ${MODE_THRESHOLDS.CLOSING.ENTER})`);
            return 'closing';
        }
        // Desce para discovery
        if (score < MODE_THRESHOLDS.WARMING.EXIT) {
            console.log(`[HYSTERESIS] Caindo para discovery (${score} < ${MODE_THRESHOLDS.WARMING.EXIT})`);
            return 'discovery';
        }
        return 'warming';
    }
    
    // Se está em discovery (ou sem modo)
    if (score >= MODE_THRESHOLDS.WARMING.ENTER) {
        if (score >= MODE_THRESHOLDS.CLOSING.ENTER) {
            return 'closing';
        }
        return 'warming';
    }
    
    return 'discovery';
}

/**
 * Verifica se transição é válida
 * @param {string} from - Modo origem
 * @param {string} to - Modo destino
 * @returns {boolean} True se válida
 */
export function isValidModeTransition(from, to) {
    // Transições válidas:
    // discovery <-> warming <-> closing
    // discovery -> closing (salto direto permitido)
    
    const transitions = {
        discovery: ['warming', 'closing'],
        warming: ['discovery', 'closing'],
        closing: ['warming', 'discovery'] // Mas hysteresis dificulta saída
    };
    
    return transitions[from]?.includes(to) || false;
}

// ============================================================================
// 5. 🛡️ LOGS ESTRUTURADOS DE DECISÃO
// ============================================================================

/**
 * Log estruturado de decisão da Amanda
 * @param {Object} data - Dados da decisão
 */
export function logAmandaDecision(data) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        version: '4.2.1',
        ...data,
        // Garante que sempre temos os campos críticos
        intentScore: data.intentScore ?? null,
        mode: data.mode ?? null,
        pricingStrategy: data.pricingStrategy ?? null,
        outcome: data.outcome ?? null
    };
    
    // Log estruturado para análise
    console.log('[AMANDA_DECISION]', JSON.stringify(logEntry));
    
    // Track para analytics
    if (data.leadId) {
        trackDecision(data.leadId, 'AMANDA_DECISION', logEntry);
    }
    
    return logEntry;
}

/**
 * Log de outcome (resultado final)
 * @param {Object} data - Dados do outcome
 */
export function logAmandaOutcome(data) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        type: 'outcome',
        ...data
    };
    
    console.log('[AMANDA_OUTCOME]', JSON.stringify(logEntry));
    
    if (data.leadId) {
        trackDecision(data.leadId, 'AMANDA_OUTCOME', logEntry);
    }
    
    return logEntry;
}

/**
 * Cria snapshot completo do estado para debug
 * @param {Object} params - Parâmetros da decisão
 * @returns {Object} Snapshot
 */
export function createDecisionSnapshot(params) {
    const { lead, memory, flags, intentScore, mode, message } = params;
    
    return {
        timestamp: new Date().toISOString(),
        lead: {
            id: lead?._id?.toString(),
            phone: lead?.phone,
            previousScore: lead?.qualificationData?.intentScore,
            previousMode: lead?.qualificationData?.conversationMode
        },
        input: {
            messageLength: message?.length,
            flags: Object.keys(flags || {}).filter(k => flags[k]),
            memoryFields: Object.keys(memory || {})
        },
        decision: {
            intentScore,
            mode,
            trend: intentScore > (lead?.qualificationData?.intentScore || 0) ? 'up' : 'down'
        }
    };
}

// ============================================================================
// 🎯 WRAPPER MASTER - Aplica todas as hardenings
// ============================================================================

/**
 * Wrapper master de hardening
 * @param {Object} params - Parâmetros originais
 * @param {Function} decisionFn - Função de decisão
 * @returns {Object} Resultado hardenizado
 */
export async function withHardening(params, decisionFn) {
    const { lead, memory } = params;
    const leadId = lead?._id?.toString();
    
    try {
        // 1. Sanitiza memory window
        const cleanMemory = {
            ...memory,
            memoryWindow: sanitizeMemoryWindow(memory?.memoryWindow)
        };
        
        // 2. Executa decisão
        const result = await decisionFn({ ...params, memory: cleanMemory });
        
        // 3. Aplica cap de segurança no score
        if (result?._v42?.intentScore !== undefined) {
            result._v42.intentScore = safeScoreCap(result._v42.intentScore);
            result._v42.isHot = result._v42.intentScore >= 75;
            result._v42.isWarm = result._v42.intentScore >= 40 && result._v42.intentScore < 75;
            result._v42.isCold = result._v42.intentScore < 40;
        }
        
        // 4. Aplica hysteresis no modo
        if (result?._v42?.mode) {
            const currentMode = lead?.qualificationData?.conversationMode || 'discovery';
            result._v42.mode = determineModeWithHysteresis(
                currentMode, 
                result._v42.intentScore
            );
        }
        
        // 5. Log estruturado
        logAmandaDecision({
            leadId,
            intentScore: result?._v42?.intentScore,
            mode: result?._v42?.mode,
            pricingStrategy: result?._v42?.pricingStrategy,
            outcome: result?.action,
            textLength: result?.text?.length,
            hardening: true
        });
        
        return result;
        
    } catch (error) {
        // Log de erro estruturado
        console.error('[HARDENING_ERROR]', {
            leadId,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });
        
        // Fallback seguro
        return {
            action: 'fallback',
            text: 'Oi! Desculpe, tive um problema técnico. Pode repetir? 💚',
            error: true,
            _v42: {
                intentScore: lead?.qualificationData?.intentScore || 50,
                mode: 'discovery',
                error: error.message
            }
        };
    }
}

export default {
    // Caps de segurança
    safeScoreCap,
    validateScoreResult,
    
    // Memory TTL
    expireMemoryWindow,
    isMemoryItemExpired,
    sanitizeMemoryWindow,
    
    // Ghost limits
    checkGhostLimits,
    safeGhostRecovery,
    
    // Hysteresis
    determineModeWithHysteresis,
    isValidModeTransition,
    
    // Logs
    logAmandaDecision,
    logAmandaOutcome,
    createDecisionSnapshot,
    
    // Wrapper master
    withHardening,
    
    // Constantes
    SCORE_CAP,
    MEMORY_TTL_HOURS,
    GHOST_LIMITS,
    MODE_THRESHOLDS
};
