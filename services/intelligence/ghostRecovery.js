/**
 * 👻 GHOST RECOVERY (Amanda 4.2)
 * ==============================
 * 
 * Recupera leads que "sumiram" no meio da conversa.
 * Follow-up automático após 30min de inatividade para leads quentes.
 * 
 * 🎯 Receita escondida de clínica grande.
 */

import { trackDecision } from '../analytics/decisionTracking.js';

// Configurações de tempo (em minutos)
const GHOST_TIMEOUT_MINUTES = 30;
const HOT_LEAD_THRESHOLD = 60;
const WARM_LEAD_THRESHOLD = 40;

// Templates de mensagens de recuperação
const RECOVERY_MESSAGES = {
    hot: [
        {
            condition: 'has_slots_mentioned',
            text: 'Oi 💚 Consegui separar aqueles horários pra você. Quer que eu confirme um?',
            cta: 'Qual dia funciona melhor?'
        },
        {
            condition: 'default',
            text: 'Oi! Vi que você estava interessada em agendar. Consegui um horário especial essa semana. Quer que eu reserve? 💚',
            cta: 'Tenho [dia] às [hora] ou [dia2] às [hora2], qual prefere?'
        }
    ],
    warm: [
        {
            condition: 'price_concern',
            text: 'Oi! Sobre o valor, consegui verificar opções de parcelamento. Quer que eu explique?',
            cta: 'Podemos dividir em até 12x no cartão. Facilita?'
        },
        {
            condition: 'default',
            text: 'Oi! Vi que você deu uma pausa. Ficou com alguma dúvida sobre o atendimento? 💚',
            cta: 'Posso esclarecer qualquer coisa!'
        }
    ],
    cold: [
        {
            condition: 'default',
            text: 'Oi! Quando quiser retomar nossa conversa, estou por aqui. 💚',
            cta: 'Qualquer dúvida é só chamar!'
        }
    ]
};

/**
 * 👻 Verifica se lead virou "ghost"
 * @param {Object} lead - Lead
 * @param {Date} lastMessageAt - Última mensagem
 * @returns {Object} Status de ghost
 */
export function detectGhost(lead, lastMessageAt = null) {
    if (!lastMessageAt) return { isGhost: false };
    
    const lastMsg = new Date(lastMessageAt);
    const now = new Date();
    const minutesSinceLastMessage = (now - lastMsg) / (1000 * 60);
    
    const intentScore = lead?.qualificationData?.intentScore || 0;
    const lastIntentScore = lead?.qualificationData?.lastIntentScore || intentScore;
    
    // Só considera ghost se:
    // 1. Passou do timeout
    // 2. Lead estava quente (>= 40)
    // 3. Ainda não recebeu follow-up
    const isGhost = 
        minutesSinceLastMessage >= GHOST_TIMEOUT_MINUTES &&
        intentScore >= WARM_LEAD_THRESHOLD &&
        !lead?.qualificationData?.ghostRecoverySent;
    
    return {
        isGhost,
        minutesSinceLastMessage: Math.round(minutesSinceLastMessage),
        intentScore,
        lastIntentScore,
        isHotGhost: intentScore >= HOT_LEAD_THRESHOLD,
        isWarmGhost: intentScore >= WARM_LEAD_THRESHOLD && intentScore < HOT_LEAD_THRESHOLD
    };
}

/**
 * 🎯 Seleciona mensagem de recuperação apropriada
 * @param {Object} ghostData - Dados do ghost
 * @param {Object} lead - Lead
 * @param {Object} context - Contexto da conversa
 * @returns {Object} Mensagem selecionada
 */
export function selectRecoveryMessage(ghostData, lead, context = {}) {
    const { isHotGhost, isWarmGhost } = ghostData;
    
    // Determina categoria
    const category = isHotGhost ? 'hot' : isWarmGhost ? 'warm' : 'cold';
    const messages = RECOVERY_MESSAGES[category];
    
    // Procura mensagem que combine com o contexto
    const { memoryWindow = [], awaitingField = null } = context;
    
    // Condições especiais
    const hasPriceConcern = memoryWindow.find(m => m.type === 'price_sensitivity');
    const hasSlotsMentioned = awaitingField === 'slot' || memoryWindow.find(m => m.type === 'schedule_intent');
    
    let selectedMessage;
    
    if (hasPriceConcern && category === 'warm') {
        selectedMessage = messages.find(m => m.condition === 'price_concern');
    } else if (hasSlotsMentioned && category === 'hot') {
        selectedMessage = messages.find(m => m.condition === 'has_slots_mentioned');
    }
    
    // Fallback para default
    if (!selectedMessage) {
        selectedMessage = messages.find(m => m.condition === 'default');
    }
    
    // Personaliza CTA se tiver dados
    let personalizedCTA = selectedMessage.cta;
    if (category === 'hot' && context.availableSlots) {
        const slots = context.availableSlots.slice(0, 2);
        personalizedCTA = `Tenho ${slots.join(' ou ')}. Qual prefere? 💚`;
    }
    
    return {
        text: selectedMessage.text,
        cta: personalizedCTA,
        category,
        urgency: isHotGhost ? 'high' : 'medium',
        tone: isHotGhost ? 'closing' : 'helpful'
    };
}

/**
 * 💾 Prepara dados para marcar recovery como enviado
 * @param {string} leadId - ID do lead
 * @param {Object} messageData - Dados da mensagem enviada
 * @returns {Object} Update para o lead
 */
export function prepareGhostRecoverySave(leadId, messageData) {
    const now = new Date();
    
    trackDecision(leadId, 'GHOST_RECOVERY_SENT', {
        category: messageData.category,
        timestamp: now,
        text: messageData.text.substring(0, 100)
    });
    
    return {
        'qualificationData.ghostRecoverySent': true,
        'qualificationData.ghostRecoverySentAt': now,
        'qualificationData.ghostRecoveryCategory': messageData.category,
        $push: {
            'qualificationData.ghostHistory': {
                sentAt: now,
                category: messageData.category,
                text: messageData.text.substring(0, 200)
            }
        }
    };
}

/**
 * 🚫 Verifica se deve suprimir recovery
 * @param {Object} lead - Lead
 * @returns {boolean} True se não deve enviar
 */
export function shouldSuppressRecovery(lead) {
    // Já agendou
    if (lead.qualificationData?.bookingScheduled) return true;
    
    // Já marcou horário recentemente
    if (lead.lastInteraction?.includes('horário confirmado')) return true;
    
    // Já respondeu após o ghost (não é mais ghost)
    const lastMsg = lead.lastMessageAt;
    const recoverySent = lead.qualificationData?.ghostRecoverySentAt;
    if (recoverySent && lastMsg && new Date(lastMsg) > new Date(recoverySent)) {
        return true;
    }
    
    // Já enviou recovery nas últimas 24h
    const lastRecovery = lead.qualificationData?.ghostRecoverySentAt;
    if (lastRecovery) {
        const hoursSince = (Date.now() - new Date(lastRecovery)) / (1000 * 60 * 60);
        if (hoursSince < 24) return true;
    }
    
    // Lead pediu para parar
    if (lead.qualificationData?.optedOut) return true;
    
    return false;
}

/**
 * 📊 Analytics: Calcula taxa de recuperação
 * @param {Array} ghostHistory - Histórico de ghosts
 * @returns {Object} Estatísticas
 */
export function calculateRecoveryStats(ghostHistory = []) {
    const total = ghostHistory.length;
    if (total === 0) return { total: 0, recovered: 0, rate: 0 };
    
    const recovered = ghostHistory.filter(h => h.recoveredAt).length;
    const rate = (recovered / total) * 100;
    
    return {
        total,
        recovered,
        rate: rate.toFixed(1),
        revenueRecovered: ghostHistory
            .filter(h => h.recoveredAt)
            .reduce((sum, h) => sum + (h.sessionValue || 0), 0)
    };
}

/**
 * 🎯 Marca ghost como recuperado
 * @param {string} leadId - ID do lead
 * @param {Object} recoveryData - Dados da recuperação
 * @returns {Object} Update para o lead
 */
export function markGhostRecovered(leadId, recoveryData = {}) {
    trackDecision(leadId, 'GHOST_RECOVERED', {
        timeToRecover: recoveryData.minutesToRecover,
        convertedToBooking: recoveryData.convertedToBooking || false
    });
    
    return {
        'qualificationData.lastGhostRecoveredAt': new Date(),
        'qualificationData.ghostRecoveryCount': (recoveryData.previousCount || 0) + 1,
        'qualificationData.ghostRecoveryRevenue': (recoveryData.previousRevenue || 0) + (recoveryData.value || 0)
    };
}

/**
 * ⏰ Agenda verificação de ghost (para cron job)
 * @returns {Object} Configuração do job
 */
export function getGhostRecoveryJobConfig() {
    return {
        name: 'ghost_recovery_check',
        schedule: '*/5 * * * *', // A cada 5 minutos
        condition: {
            lastMessageBefore: new Date(Date.now() - GHOST_TIMEOUT_MINUTES * 60 * 1000),
            intentScoreMin: WARM_LEAD_THRESHOLD,
            ghostRecoverySent: false
        }
    };
}

export default {
    detectGhost,
    selectRecoveryMessage,
    prepareGhostRecoverySave,
    shouldSuppressRecovery,
    calculateRecoveryStats,
    markGhostRecovered,
    getGhostRecoveryJobConfig,
    GHOST_TIMEOUT_MINUTES,
    HOT_LEAD_THRESHOLD,
    WARM_LEAD_THRESHOLD
};
