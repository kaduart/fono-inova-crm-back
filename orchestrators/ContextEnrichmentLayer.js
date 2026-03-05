/**
 * 🎯 CONTEXT ENRICHMENT LAYER - FASE 3.2
 *
 * OBJETIVO: Enriquecer contexto da IA com insights de 75k linhas de conversas reais
 * REGRA FUNDAMENTAL: NUNCA retornar resposta, APENAS adicionar informações ao contexto
 *
 * A IA (Claude) recebe contexto mais rico e decide a melhor resposta.
 * Não engessamos, apenas damos insights baseados em dados reais.
 *
 * @version 3.0.0
 * @baseado-em 75.008 linhas de conversas reais do WhatsApp
 */

import pricing, { getTherapyPricing, PRICING } from '../config/pricing.js';

/**
 * 🧠 Enriquece contexto com insights estratégicos dos detectores
 *
 * Esta função NÃO decide respostas, apenas adiciona informações valiosas
 * que a IA pode usar para tomar decisões mais inteligentes.
 *
 * @param {Object} flags - Flags dos detectores contextuais (FASE 1 + FASE 2)
 * @param {Object} lead - Dados do lead
 * @param {Object} enrichedContext - Contexto já existente
 * @returns {Object} Contexto enriquecido (NUNCA retorna resposta direta)
 */
export function buildStrategicContext(flags, lead, enrichedContext) {
    // ✅ Mantém TUDO que já existia (100% backward compatible)
    const strategic = {
        ...enrichedContext,

        // 🆕 Adiciona hints estratégicos (sugestões, não ordens)
        strategicHints: {}
    };

    // ========================================
    // 💰 PRICE INTELLIGENCE
    // Baseado em 234 ocorrências reais (16.5% do volume)
    // ========================================

    if (flags._price?.detected) {
        strategic.strategicHints.price = {
            // 📊 Dados de detecção
            type: flags._price.priceType, // 'insistence', 'objection', 'comparison', 'negotiation', 'acceptance'
            confidence: flags._price.confidence,

            // 🔍 Padrões identificados (dos 75k linhas)
            patterns: {
                hasObjection: flags._price.hasObjection,
                wantsNegotiation: flags._price.wantsNegotiation,
                isInsistent: flags._price.isInsistent,
                alreadyMentioned: flags._price.alreadyMentioned,
                requiresSpecialHandling: flags._price.requiresSpecialHandling
            },

            // 💡 Sugestões (IA decide se usa ou não)
            suggestions: {
                // Tom sugerido baseado no tipo de pergunta
                tone: flags._price.hasObjection ? 'value-focused' :
                      flags._price.wantsNegotiation ? 'flexible' :
                      flags._price.isInsistent ? 'reassuring' :
                      'friendly',

                // Abordagem sugerida
                approach: flags._price.hasObjection ? 'emphasize_benefits' :
                          flags._price.wantsNegotiation ? 'show_flexibility' :
                          flags._price.isInsistent ? 'reaffirm_value' :
                          'direct_answer',

                // Ênfase sugerida
                emphasis: flags._price.hasObjection ? 'quality_and_results' :
                          flags._price.wantsNegotiation ? 'payment_options' :
                          'price_value',

                // ✅ Dados reais de pricing.js (NÃO hardcoded)
                relevantPricing: getPricingForContext(lead.therapyArea)
            },

            // 🎯 Contexto adicional para IA
            context: {
                priceWasMentionedBefore: flags._price.alreadyMentioned,
                leadShowsCostConcern: flags._price.hasObjection,
                leadOpenToNegotiation: flags._price.wantsNegotiation,
                leadNeedsReassurance: flags._price.isInsistent && flags._price.alreadyMentioned
            }
        };

        // 📝 Log para tracking (não bloqueia)
        console.log("💰 [CONTEXT-ENRICHMENT] Price intelligence added:", {
            type: flags._price.priceType,
            confidence: flags._price.confidence,
            suggestedTone: strategic.strategicHints.price.suggestions.tone
        });
    }

    // ========================================
    // 📅 SCHEDULING INTELLIGENCE
    // Baseado em 306 ocorrências reais (21.6% do volume - 2º lugar!)
    // ========================================

    if (flags._scheduling?.detected) {
        strategic.strategicHints.scheduling = {
            // 📊 Dados de detecção
            type: flags._scheduling.schedulingType, // 'new', 'reschedule', 'cancellation', 'generic'
            confidence: flags._scheduling.confidence,

            // 🔍 Padrões identificados (dos 75k linhas)
            patterns: {
                hasUrgency: flags._scheduling.hasUrgency,
                preferredPeriod: flags._scheduling.preferredPeriod, // 'morning', 'afternoon', 'flexible', null
                isReschedule: flags._scheduling.isReschedule,
                isCancellation: flags._scheduling.isCancellation,
                isFlexible: flags._scheduling.isFlexible,
                requiresUrgentHandling: flags._scheduling.requiresUrgentHandling
            },

            // 💡 Sugestões (IA decide se usa ou não)
            suggestions: {
                // Prioridade sugerida
                priority: flags._scheduling.hasUrgency ? 'high' :
                          flags._scheduling.isReschedule ? 'medium' :
                          'normal',

                // Tom sugerido
                tone: flags._scheduling.hasUrgency ? 'responsive_and_quick' :
                      flags._scheduling.isCancellation ? 'understanding_and_helpful' :
                      flags._scheduling.isReschedule ? 'accommodating' :
                      'helpful',

                // Foco sugerido
                focus: flags._scheduling.hasUrgency ? 'immediate_slots' :
                       flags._scheduling.preferredPeriod ? 'period_specific_slots' :
                       flags._scheduling.isReschedule ? 'alternative_slots' :
                       'available_slots',

                // Período para filtrar slots
                periodFocus: flags._scheduling.preferredPeriod || 'any',

                // ✅ Se é remarcação, informar horário atual (se disponível)
                currentSlot: flags._scheduling.isReschedule ?
                    (lead.pendingChosenSlot || lead.bookedSlot || null) :
                    null
            },

            // 🎯 Contexto adicional para IA
            context: {
                needsUrgentSlots: flags._scheduling.hasUrgency,
                hasPreferredPeriod: !!flags._scheduling.preferredPeriod,
                isChangingExistingSlot: flags._scheduling.isReschedule,
                mightCancelInstead: flags._scheduling.isCancellation,
                flexibleOnTiming: flags._scheduling.isFlexible
            }
        };

        // 📝 Log para tracking
        console.log("📅 [CONTEXT-ENRICHMENT] Scheduling intelligence added:", {
            type: flags._scheduling.schedulingType,
            urgency: flags._scheduling.hasUrgency,
            period: flags._scheduling.preferredPeriod,
            suggestedPriority: strategic.strategicHints.scheduling.suggestions.priority
        });
    }

    // ========================================
    // 🏥 INSURANCE INTELLIGENCE (FASE 1)
    // ========================================

    if (flags._insurance?.detected) {
        strategic.strategicHints.insurance = {
            // 📊 Dados de detecção
            plan: flags._insurance.plan,
            intentType: flags._insurance.intentType,
            confidence: flags._insurance.confidence,

            // 💡 Sugestões
            suggestions: {
                // Wisdom key para resposta específica (se disponível)
                wisdomKey: flags._insurance.wisdomKey,

                // Tom sugerido
                tone: flags._insurance.intentType === 'objection' ? 'empathetic' : 'informative'
            },

            // 🎯 Contexto adicional
            context: {
                hasSpecificPlan: !!flags._insurance.plan,
                isInsuranceObjection: flags._insurance.intentType === 'objection'
            }
        };

        console.log("🏥 [CONTEXT-ENRICHMENT] Insurance intelligence added:", {
            plan: flags._insurance.plan,
            intentType: flags._insurance.intentType
        });
    }

    // ========================================
    // ✅ CONFIRMATION INTELLIGENCE (FASE 1)
    // ========================================

    if (flags._confirmation?.detected) {
        strategic.strategicHints.confirmation = {
            // 📊 Dados de detecção
            meaning: flags._confirmation.semanticMeaning,
            confidence: flags._confirmation.confidence,

            // 💡 Sugestões
            suggestions: {
                requiresValidation: flags._confirmation.requiresValidation,
                tone: 'confirming'
            },

            // 🎯 Contexto adicional
            context: {
                isAmbiguous: flags._confirmation.requiresValidation,
                semanticMeaning: flags._confirmation.semanticMeaning
            }
        };

        console.log("✅ [CONTEXT-ENRICHMENT] Confirmation intelligence added:", {
            meaning: flags._confirmation.semanticMeaning,
            confidence: flags._confirmation.confidence
        });
    }

    // ========================================
    // 🤝 WELCOMING TONE + SCHEDULING FOCUS (PONTO 2)
    // "Acolhimento mas foco em agendar SEM forçar"
    // ========================================

    strategic.strategicHints.welcomingApproach = {
        // 💡 Princípio fundamental
        principle: "Be welcoming and empathetic, gently guide towards scheduling without forcing",

        // 🎯 Sugestões de tom
        suggestions: {
            // Tom sempre acolhedor e empático
            tone: 'warm_and_welcoming',

            // Abordagem: ouvir primeiro, depois sugerir agendamento
            approach: 'listen_first_then_suggest',

            // NUNCA forçar, sempre oferecer
            schedulingStyle: 'gentle_invitation', // não 'pushy' ou 'forcing'

            // Frases sugeridas (IA pode adaptar)
            welcomingPhrases: [
                "Entendo sua preocupação 💚",
                "Fico feliz que você entrou em contato!",
                "Vamos te ajudar com isso 😊"
            ],

            // Transição suave para agendamento (não abrupta)
            schedulingTransition: [
                "Quer que eu já te passe alguns horários disponíveis?",
                "Posso te mostrar os horários que temos essa semana?",
                "Se quiser, podemos já agendar. O que acha?"
            ]
        },

        // 🎯 Contexto para IA
        context: {
            prioritizeEmpathy: true,
            allowLeadToDecidePace: true, // Lead decide ritmo, não forçamos
            suggestDontPush: true,
            maintainWarmTone: true
        }
    };

    console.log("🤝 [CONTEXT-ENRICHMENT] Welcoming approach added: empathy first, gentle scheduling suggestion");

    // ========================================
    // 🎯 COMPLAINT PRIORITY (PONTO 1)
    // Garantir que queixa SEMPRE vem primeiro
    // ========================================

    const hasComplaint = !!(
        lead?.complaint ||
        lead?.patientInfo?.complaint ||
        lead?.autoBookingContext?.complaint
    );

    const hasTherapyArea = !!(
        lead?.therapyArea ||
        flags?.therapyArea
    );

    // ✅ FIX: Suprimir "MUST ask complaint" quando o usuário tem ação imediata pendente.
    // Queixa é pré-requisito clínico, NÃO comercial. Coleta-se depois do agendamento.
    const userHasImmediateAction = !!(
        flags?.wantsSchedule ||
        flags?.mentionsUrgency ||
        flags?.asksPrice ||
        flags?.insistsPrice ||
        flags?.asksPlans ||
        flags?.asksAddress ||
        flags?.asksLocation ||
        flags?.confirmsData ||
        flags?.wantsReschedule ||
        lead?.pendingSchedulingSlots ||
        lead?.pendingChosenSlot ||
        lead?.awaitingResponseFor
    );

    strategic.strategicHints.complaintPriority = {
        // 📊 Estado atual
        hasComplaint,
        hasTherapyArea,

        // ✅ Só pedir queixa se não há ação imediata pendente
        shouldAskComplaint: !hasComplaint && !hasTherapyArea && !userHasImmediateAction,

        // 💡 Sugestão de como perguntar (IA pode adaptar)
        suggestedComplaintQuestion: !hasComplaint && !userHasImmediateAction ?
            "Me conta um pouquinho: o que você tem observado no dia a dia que te preocupou? 💚" :
            null,

        // 🎯 Contexto
        context: {
            complaintIsFirstPriority: !hasComplaint && !userHasImmediateAction,
            readyForNextStep: hasComplaint,
            suppressedByImmediateAction: userHasImmediateAction
        }
    };

    if (strategic.strategicHints.complaintPriority.shouldAskComplaint) {
        console.log("🎯 [CONTEXT-ENRICHMENT] Complaint priority: MUST ask complaint first");
    } else if (userHasImmediateAction) {
        console.log("🚀 [CONTEXT-ENRICHMENT] Complaint suppressed: user has immediate action pending");
    }

    // ========================================
    // 📊 METADATA (para analytics e debugging)
    // ========================================

    strategic._enrichment = {
        timestamp: new Date().toISOString(),
        version: '3.0.0',
        phase: 'FASE_3',
        enrichedBy: 'ContextEnrichmentLayer',

        // ✅ Tracking de quais detectores foram úteis
        activeEnrichments: {
            price: !!flags._price?.detected,
            scheduling: !!flags._scheduling?.detected,
            insurance: !!flags._insurance?.detected,
            confirmation: !!flags._confirmation?.detected,
            complaintPriority: strategic.strategicHints.complaintPriority.shouldAskComplaint
        },

        // 📊 Estatísticas de confiança
        avgConfidence: calculateAverageConfidence(flags)
    };

    return strategic;
}

/**
 * 💰 Helper: Busca pricing relevante do pricing.js (NÃO hardcoded)
 */
function getPricingForContext(therapyArea) {
    const area = therapyArea || 'fonoaudiologia';
    const priceData = getTherapyPricing(area);

    if (!priceData) {
        // Fallback para avaliação inicial padrão
        return {
            avaliacao: PRICING.AVALIACAO_INICIAL,
            pacote_mensal: null,
            parcelas: null,
            hasPackage: false
        };
    }

    return {
        avaliacao: priceData.avaliacao || PRICING.AVALIACAO_INICIAL,
        pacote_mensal: priceData.pacoteMensal || null,
        parcelas: priceData.parcelamento || null,
        hasPackage: !!priceData.pacoteMensal
    };
}

/**
 * 📊 Helper: Calcula confiança média das detecções
 */
function calculateAverageConfidence(flags) {
    const confidences = [];

    if (flags._price?.confidence) confidences.push(flags._price.confidence);
    if (flags._scheduling?.confidence) confidences.push(flags._scheduling.confidence);
    if (flags._insurance?.confidence) confidences.push(flags._insurance.confidence);
    if (flags._confirmation?.confidence) confidences.push(flags._confirmation.confidence);

    if (confidences.length === 0) return 0;

    const sum = confidences.reduce((a, b) => a + b, 0);
    return Math.round((sum / confidences.length) * 100) / 100;
}

/**
 * 📝 Helper: Log detalhado para tracking (não bloqueia fluxo)
 *
 * Útil para debugging e análise de quais insights estão sendo gerados
 */
export function logStrategicEnrichment(strategic, flags) {
    if (!strategic.strategicHints) {
        console.log("ℹ️ [CONTEXT-ENRICHMENT] No strategic hints added");
        return;
    }

    const summary = {
        hasPrice: !!strategic.strategicHints.price,
        hasScheduling: !!strategic.strategicHints.scheduling,
        hasInsurance: !!strategic.strategicHints.insurance,
        hasConfirmation: !!strategic.strategicHints.confirmation,
        mustAskComplaint: strategic.strategicHints.complaintPriority?.shouldAskComplaint,
        avgConfidence: strategic._enrichment.avgConfidence
    };

    console.log("🎯 [CONTEXT-ENRICHMENT] Strategic context summary:", summary);

    // Log detalhado se houver insights importantes
    if (strategic.strategicHints.price?.patterns.hasObjection) {
        console.log("  💡 Price objection detected → suggesting value-focused approach");
    }

    if (strategic.strategicHints.scheduling?.patterns.hasUrgency) {
        console.log("  💡 Urgency detected → suggesting immediate slots focus");
    }

    if (strategic.strategicHints.complaintPriority?.shouldAskComplaint) {
        console.log("  💡 Complaint missing → MUST ask before anything else");
    }
}

/**
 * 🧪 Helper: Exporta stats para análise (FASE 4 - Learning Loop)
 */
export function getEnrichmentStats() {
    // Placeholder para FASE 4
    return {
        message: "Enrichment stats will be available in FASE 4 (Learning Loop)",
        version: "3.0.0"
    };
}

// Exportações
export default {
    buildStrategicContext,
    logStrategicEnrichment,
    getEnrichmentStats
};
