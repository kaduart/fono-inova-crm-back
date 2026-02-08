/**
 * 🚀 DecisionEngine 4.2 - Wrapper de Integração
 * ============================================
 * 
 * Integra as melhorias 4.2 com o DecisionEngine 3.0 existente.
 * Aditivo, não substitui.
 */

import { decide as decideCore } from './DecisionEngine.js';
import { calculateAccumulativeScore, prepareIntentScoreForSave } from './intentScorePersistence.js';
import { prepareMemoryForSave, formatMemoryForPrompt } from './memoryWindow.js';
import { determinePricingStrategy, buildStrategicPriceText } from './pricingStrategy.js';
import { determineMode, buildModeInstruction, prepareModeForSave } from './conversationMode.js';
import { detectGhost, selectRecoveryMessage, shouldSuppressRecovery } from './ghostRecovery.js';

/**
 * 🎯 decide() - Versão 4.2 com todas as melhorias
 * 
 * Adiciona:
 * 1. Intent Score acumulativo
 * 2. Modo de conversação (closing/warming/discovery)
 * 3. Memory Window
 * 4. Smart Pricing
 * 5. Ghost Recovery detection
 */
export async function decide42(params) {
    const { analysis, memory, flags, lead, message, chatContext } = params;
    
    // 1. Calcula Intent Score Acumulativo
    const previousScore = lead?.qualificationData?.intentScore || 0;
    const lastInteraction = lead?.qualificationData?.lastIntentUpdate;
    const currentSignals = calculateSignals(flags, message);
    
    const intentResult = calculateAccumulativeScore({
        previousScore,
        currentSignals,
        lastInteraction,
        leadId: lead?._id?.toString()
    });
    
    // 2. Determina Modo de Conversação
    const mode = determineMode(intentResult.score, intentResult.trend);
    const modeConfig = buildModeInstruction(mode, {
        score: intentResult.score,
        patientName: memory?.patientName,
        patientAge: memory?.patientAge
    });
    
    // 3. Atualiza Memory Window
    const memoryUpdate = prepareMemoryForSave(lead, message, analysis?.extractedInfo);
    
    // 4. Verifica Ghost Recovery
    const lastMessageAt = lead?.lastMessageAt;
    const ghostStatus = detectGhost(lead, lastMessageAt);
    
    let ghostMessage = null;
    if (ghostStatus.isGhost && !shouldSuppressRecovery(lead)) {
        ghostMessage = selectRecoveryMessage(ghostStatus, lead, {
            memoryWindow: memoryUpdate['qualificationData.memoryWindow']
        });
    }
    
    // 5. Chama DecisionEngine core
    const result = await decideCore(params);
    
    // 6. Aplica estratégia de preço se for pergunta de preço
    if (flags.asksPrice && result.text) {
        const pricingStrategy = determinePricingStrategy(intentResult.score, flags);
        const strategicPrice = buildStrategicPriceText(
            memory?.therapyArea || 'FONOAUDIOLOGIA',
            pricingStrategy
        );
        
        // Substitui apenas se for modo closing (assertivo)
        if (mode === 'closing' && pricingStrategy === 'package_first') {
            result.text = strategicPrice.body;
            result.metadata = { ...result.metadata, pricingStrategy };
        }
    }
    
    // 7. Prepara updates para salvar no lead
    const updates = {
        ...prepareIntentScoreForSave(lead, intentResult),
        ...memoryUpdate,
        ...prepareModeForSave(lead, mode, intentResult.score),
        ...(ghostMessage ? { ghostRecoveryMessage: ghostMessage } : {})
    };
    
    // 8. Adiciona metadata 4.2 ao resultado
    return {
        ...result,
        _v42: {
            intentScore: intentResult.score,
            mode,
            trend: intentResult.trend,
            isHot: intentResult.isHot,
            isWarm: intentResult.isWarm,
            updates,
            ghostDetected: ghostStatus.isGhost,
            ghostMessage
        }
    };
}

/**
 * 🧮 Calcula sinais atuais da mensagem
 */
function calculateSignals(flags, message) {
    let signals = 0;
    const text = (message || '').toLowerCase();
    
    if (flags.wantsSchedule || /quero agendar|vamos marcar|pode agendar/i.test(text)) signals += 50;
    else if (flags.asksSchedule || /hor[áa]rio|vaga/i.test(text)) signals += 25;
    
    if (flags.asksPrice || /quanto|custa|pre[çc]o|valor/i.test(text)) signals += 15;
    if (flags.asksPackage || /pacote/i.test(text)) signals += 20;
    if (flags.hasCompleteData) signals += 30;
    if (flags.expressedUrgency || /urgente|logo|r[áa]pido/i.test(text)) signals += 15;
    
    return Math.min(100, signals);
}

/**
 * 👻 Verifica se deve enviar ghost recovery
 */
export function shouldSendGhostRecovery(lead) {
    const lastMessageAt = lead?.lastMessageAt;
    const ghostStatus = detectGhost(lead, lastMessageAt);
    return ghostStatus.isGhost && !shouldSuppressRecovery(lead);
}

/**
 * 💬 Gera mensagem de ghost recovery
 */
export function generateGhostRecovery(lead, context = {}) {
    const lastMessageAt = lead?.lastMessageAt;
    const ghostStatus = detectGhost(lead, lastMessageAt);
    
    if (!ghostStatus.isGhost) return null;
    
    return selectRecoveryMessage(ghostStatus, lead, context);
}

/**
 * 📊 Retorna status do lead para dashboard
 */
export function getLeadStatus(lead) {
    const score = lead?.qualificationData?.intentScore || 0;
    const mode = lead?.qualificationData?.conversationMode || 'discovery';
    const memoryWindow = lead?.qualificationData?.memoryWindow || [];
    
    return {
        score,
        mode,
        isHot: score >= 75,
        isWarm: score >= 40 && score < 75,
        isCold: score < 40,
        memoryCount: memoryWindow.length,
        lastUpdate: lead?.qualificationData?.lastIntentUpdate
    };
}

export default {
    decide42,
    shouldSendGhostRecovery,
    generateGhostRecovery,
    getLeadStatus
};
