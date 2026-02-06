import Logger from '../services/utils/Logger.js';

// ✅ INFRAESTRUTURA UNIFICADA (leadContext.js = fonte única de verdade)
import enrichLeadContext, { updateExtractedInfo } from '../services/leadContext.js';
import { analyzeLeadMessage } from '../services/intelligence/leadIntelligence.js';
import { nextStage } from '../services/intelligence/stageEngine.js';
import { clinicalRulesEngine } from '../services/intelligence/clinicalRulesEngine.js';
import { calculateUrgency } from '../services/intelligence/UrgencyScheduler.js';
import { decisionEngine } from '../services/intelligence/DecisionEngine.js';

// ✅ UTILITÁRIOS EXISTENTES
import { normalizePeriod } from '../utils/normalizePeriod.js';
import { detectAllFlags } from '../utils/flagsDetector.js';
import { detectAllTherapies } from '../utils/therapyDetector.js';
import { extractPreferredDateFromText } from '../utils/extractPreferredDateFromText.js';

// ✅ SERVIÇOS DE AGENDAMENTO
import {
    findAvailableSlots,
    pickSlotFromUserReply,
    validateSlotStillAvailable
} from '../services/amandaBookingService.js';
import { mapFlagsToBookingProduct } from '../utils/bookingProductMapper.js';

// ✅ HANDLERS EXISTENTES
import * as handlers from '../handlers/index.js';
import Leads from '../models/Leads.js';
import ChatContext from '../models/ChatContext.js';
import { generateHandlerResponse } from '../services/aiAmandaService.js';
import generateConversationSummary, { needsNewSummary } from '../services/conversationSummary.js';

// ✅ DETECTOR EXISTENTE
import IntentDetector from '../detectors/IntentDetector.js';

// 🧠 EXTRATOR SEMÂNTICO (fallback inteligente quando regex falham)
import { smartExtract } from '../services/intelligence/semanticExtractor.js';
import { buildResponse } from '../services/intelligence/naturalResponseBuilder.js';
import { getCachedContext, setCachedContext } from '../services/intelligence/contextCache.js';
import * as ContextMemory from '../services/intelligence/contextMemory.js';

/**
 * 🎯 CONVERSATION OUTCOME DETECTION (Amanda 4.1)
 * Detecta o resultado da conversa para analytics e otimização
 * @returns {{type: string, score: number}|null}
 */
function determineConversationOutcome({ result, decision, memoryContext, previousOutcome }) {
    const flags = result?.extractedInfo || {};
    const action = decision?.action;
    const intentScore = memoryContext?.intentScore || 0;
    
    // 🌟 BOOKING_SCHEDULED - Agendamento confirmado
    if (action === 'schedule' || flags.preferredDate || flags.bookingScheduled) {
        return { type: 'booking_scheduled', score: 100 };
    }
    
    // 🔥 HOT_LEAD - Lead quente (quase agendando)
    if (intentScore >= 70 && (flags.wantsSchedule || flags.asksPrice)) {
        return { type: 'hot_lead', score: intentScore };
    }
    
    // 🔥 BOOKING_INTENT - Intenção clara de agendar
    if (flags.wantsSchedule || flags.bookingIntent) {
        return { type: 'booking_intent', score: 75 };
    }
    
    // 🚧 WARM_LEAD - Lead morno (precisa de follow-up)
    if (action === 'warm_lead_close' || flags.warmLeadPattern) {
        return { type: 'warm_lead', score: 60 };
    }
    
    // 📊 DATA_COMPLETE - Dados completos coletados
    const hasData = flags.patientName && flags.patientAge && flags.primaryComplaint;
    if (hasData && !previousOutcome) {
        return { type: 'data_complete', score: 50 };
    }
    
    // 💰 PRICE_CONCERN - Preocupação com preço
    if (flags.asksPrice || flags.asksInsurance || flags.asksPackage) {
        return { type: 'price_concern', score: 45 };
    }
    
    // 🤗 ACOLHIMENTO - Apenas acolhimento, sem progresso
    if (action === 'acknowledge_pain' && !hasData) {
        return { type: 'acolhimento', score: 20 };
    }
    
    // ❌ NO_PROGRESS - Sem progresso após múltiplas mensagens
    const msgCount = memoryContext?.conversationHistory?.length || 0;
    if (msgCount > 5 && intentScore < 30) {
        return { type: 'no_progress', score: 10 };
    }
    
    // 🕐 IN_PROGRESS - Conversa em andamento
    return { type: 'in_progress', score: intentScore };
}

export class WhatsAppOrchestrator {
    constructor() {
        this.logger = new Logger('WhatsAppOrchestrator');
        this.intentDetector = new IntentDetector();
    }

    normalizeHandler(handler) {
        if (!handler) return null;
        if (typeof handler.execute === 'function') return handler;
        if (typeof handler === 'function') return { execute: handler };
        if (handler.default) return this.normalizeHandler(handler.default);
        return null;
    }

    async process({ lead, message, services }) {
        try {
            const text = message?.content || message?.text || '';

            // =========================
            // 1️⃣ CONTEXTO (COM CACHE)
            // =========================
            // ✅ CONTEXTO UNIFICADO (leadContext.js = fonte única)
            let memoryContext = getCachedContext(lead._id);

            if (!memoryContext) {
                // Cache miss - busca do banco
                memoryContext = await enrichLeadContext(lead._id);
                setCachedContext(lead._id, memoryContext);
            }

            // Flags usando SEU detector
            const flags = detectAllFlags(text, lead, {
                stage: lead?.stage,
                messageCount: memoryContext?.conversationHistory?.length || 0,
                conversationHistory: memoryContext?.conversationHistory || []
            });

            // Terapias usando SEU detector
            const detectedTherapies = detectAllTherapies(text);

            // =========================
            // 2️⃣ ANÁLISE INTELIGÊNCIA (SEUS SERVIÇOS)
            // =========================
            const [llmAnalysis, intentResult] = await Promise.all([
                analyzeLeadMessage({
                    text,
                    lead,
                    history: memoryContext?.conversationHistory || []
                }).catch(() => ({})),
                this.intentDetector.detect(message, memoryContext)
            ]);

            const intelligent = llmAnalysis?.extractedInfo || {};

            // Monta analysis no formato que DecisionEngine espera
            const analysis = {
                ...llmAnalysis,
                flags: { ...flags, ...intentResult.flags },
                therapyArea: intentResult.therapy || intelligent?.especialidade,
                intent: this.determinePrimaryIntent(flags, intentResult, detectedTherapies),
                confidence: intentResult.confidence || 0.5,
                extractedInfo: intelligent
            };

            this.logger.debug('ANALYSIS_COMPLETE', {
                intent: analysis.intent,
                therapy: analysis.therapyArea,
                hasFlags: Object.keys(flags).filter(k => flags[k]).join(',')
            });

            // =========================
            // 3️⃣ INFERRIDOS (EXTRAÇÃO DE DADOS)
            // =========================
            // Carrega contexto do chat para verificar estados pendentes (awaitingComplaint, etc)
            const chatContext = await ChatContext.findOne({ lead: lead._id }).lean();

            const inferred = await this.extractInferredData({
                text,
                flags,
                detectedTherapies,
                intelligent,
                lead,
                memoryContext,
                chatContext
            });

            // =========================
            // 4️⃣ BOOKING CONTEXT (ESTADO DO AGENDAMENTO)
            // =========================
            const bookingContext = await this.buildBookingContext({
                lead,
                memoryContext,
                text,
                inferred
            });

            // =========================
            // 5️⃣ MISSING FIELDS (O QUE FALTA?)
            // =========================
            const missing = this.calculateMissing({
                lead,
                inferred,
                bookingContext,
                flags
            });

            // =========================
            // 6️⃣ REGRAS CLÍNICAS (SEU SERVIÇO)
            // =========================
            const clinicalRules = clinicalRulesEngine({
                memoryContext,
                analysis,
                lead
            });

            // =========================
            // 7️⃣ URGÊNCIA (SEU SERVIÇO)
            // =========================
            const urgency = calculateUrgency(analysis, memoryContext);

            // =========================
            // 8️⃣ DECISION ENGINE (USA O SEU!)
            // =========================

            // 🐛 DEBUG: Estado antes da decisão
            this.logger.info('DECISION_ENGINE_INPUT', {
                intent: analysis?.intent,
                missing: {
                    needsTherapy: missing.needsTherapy,
                    needsComplaint: missing.needsComplaint,
                    needsAge: missing.needsAge,
                    needsPeriod: missing.needsPeriod,
                    needsSlot: missing.needsSlot
                },
                inferred: {
                    therapy: inferred.therapy,
                    complaint: inferred.complaint?.substring(0, 30),
                    age: inferred.age
                },
                flags: {
                    asksPrice: flags.asksPrice,
                    wantsSchedule: flags.wantsSchedule
                }
            });

            // 🐛 DEBUG: Mesclar chatContext com memoryContext para decisão
            // 🔥 CRÍTICO: Os dados inferidos da MENSAGEM ATUAL têm prioridade sobre o contexto antigo!
            const mergedMemory = {
                ...memoryContext,
                ...(chatContext?.lastExtractedInfo || {}),
                // Prioridade para dados da MENSAGEM ATUAL (inferred), depois chatContext, depois memoryContext
                patientAge: inferred?.age || chatContext?.lastExtractedInfo?.age || memoryContext?.patientAge,
                therapyArea: inferred?.therapy || chatContext?.lastExtractedInfo?.therapy || memoryContext?.therapyArea,
                complaint: inferred?.complaint || chatContext?.lastExtractedInfo?.complaint || memoryContext?.complaint,
                // 🔥 CORREÇÃO: Adicionar período extraído da mensagem atual
                preferredPeriod: inferred?.period || chatContext?.lastExtractedInfo?.period || memoryContext?.preferredPeriod,
                period: inferred?.period || chatContext?.lastExtractedInfo?.period || memoryContext?.period,
                // 🔥 CRÍTICO: Adicionar dados de múltiplas terapias
                hasMultipleTherapies: inferred?.hasMultipleTherapies || chatContext?.lastExtractedInfo?.hasMultipleTherapies || memoryContext?.hasMultipleTherapies,
                allDetectedTherapies: inferred?.allDetectedTherapies || chatContext?.lastExtractedInfo?.allDetectedTherapies || memoryContext?.allDetectedTherapies,
            };
            this.logger.info('MERGED_MEMORY', {
                leadId: lead._id?.toString(),
                memoryContext: {
                    patientAge: memoryContext?.patientAge,
                    therapyArea: memoryContext?.therapyArea,
                    complaint: memoryContext?.complaint,
                    preferredPeriod: memoryContext?.preferredPeriod
                },
                chatContext: chatContext?.lastExtractedInfo,
                mergedMemory: {
                    patientAge: mergedMemory.patientAge,
                    therapyArea: mergedMemory.therapyArea,
                    complaint: mergedMemory.complaint,
                    preferredPeriod: mergedMemory.preferredPeriod,
                    period: mergedMemory.period
                }
            });

            // 🐛 DEBUG: Verificar chatContext antes de passar para decisionEngine
            this.logger.info('BEFORE_DECISION_ENGINE', {
                leadId: lead._id?.toString(),
                chatContextAwaitingField: chatContext?.lastExtractedInfo?.awaitingField,
                chatContextObj: chatContext,  // Log completo do objeto
                hasChatContext: !!chatContext,
                hasLastExtractedInfo: !!chatContext?.lastExtractedInfo
            });

            const decision = await decisionEngine({
                analysis,
                memory: mergedMemory,
                flags,
                missing,
                urgency,
                bookingContext,
                clinicalRules,
                lead,
                message: { text },
                chatContext,
                // 🆕 FIX BUG 5a: contextPack para warm recall funcionar
                contextPack: {
                    lastDate: lead.lastContactAt || lead.updatedAt || null,
                    messageCount: memoryContext?.conversationHistory?.length || 0,
                    lastHandler: chatContext?.lastExtractedInfo?.lastHandler
                }
            });

            this.logger.info('DECISION', {
                handler: decision.handler,
                action: decision.action,
                reason: decision.reason,
                preserveState: decision.preserveBookingState,
                pendingField: decision.pendingField
            });

            // =========================
            // 9️⃣ EXECUTA HANDLER DECIDIDO
            // =========================
            const rawHandler = handlers[decision.handler] || handlers.fallbackHandler;
            const handler = this.normalizeHandler(rawHandler);

            const decisionContext = {
                message,
                lead,
                memory: memoryContext,
                missing,
                booking: bookingContext,
                analysis,
                services,
                // Passa inferidos para handlers usarem
                inferredTherapy: inferred.therapy,
                inferredComplaint: inferred.complaint,
                inferredAge: inferred.age,
                inferredPeriod: inferred.period,
                detectedTherapies,
                // 🆕 MÚLTIPLAS TERAPIAS
                allDetectedTherapies: inferred.allDetectedTherapies,
                hasMultipleTherapies: inferred.hasMultipleTherapies,
                flags,
                // 🆕 PASSAR TEXTO E AÇÃO DO DECISION ENGINE
                action: decision.action,
                text: decision.text,
                extractedInfo: decision.extractedInfo
            };

            const handlerStart = Date.now();
            let result = await handler.execute({ decisionContext, services });
            const handlerTime = Date.now() - handlerStart;

            this.logger.info('HANDLER_EXECUTED', {
                leadId: lead._id?.toString(),
                handler: decision.handler,
                handlerTimeMs: handlerTime,
                hasText: !!result?.text,
                textLength: result?.text?.length,
                extractedInfo: result?.extractedInfo
            });

            // =========================
            // 🎯 FIX BUG 1: INTERCEPTA slot_selection → BUSCA SLOTS REAIS
            // =========================
            if (result?.extractedInfo?.awaitingField === 'slot_selection' && inferred.therapy && inferred.period) {
                try {
                    this.logger.info('SLOT_FETCH_TRIGGERED', {
                        leadId: lead._id?.toString(),
                        therapy: inferred.therapy,
                        period: inferred.period
                    });

                    const { findAvailableSlots } = await import('../services/amandaBookingService.js');
                    
                    const slots = await findAvailableSlots({
                        therapyArea: inferred.therapy,
                        preferredPeriod: inferred.period,
                        patientAge: inferred.age
                    });

                    if (slots?.primary?.length > 0) {
                        // Formata slots para mensagem
                        const slotsText = slots.primary.slice(0, 4).map(s => 
                            `• ${s.day} às ${s.time} (${s.doctorName || 'Profissional'})`
                        ).join('\n');
                        
                        result.text = `Encontrei essas opções:\n\n${slotsText}\n\nQual funciona melhor? 💚`;
                        result.extractedInfo.offeredSlots = true;
                        result.extractedInfo.slotCount = slots.primary.length;

                        // Salva slots no lead para próximo passo
                        await Leads.findByIdAndUpdate(lead._id, {
                            $set: {
                                pendingSchedulingSlots: slots,
                                'autoBookingContext.lastOfferedSlots': slots,
                                'autoBookingContext.active': true,
                                'autoBookingContext.therapyArea': inferred.therapy,
                                'autoBookingContext.preferredPeriod': inferred.period
                            }
                        });

                        this.logger.info('SLOT_FETCH_SUCCESS', {
                            leadId: lead._id?.toString(),
                            count: slots.primary.length,
                            therapy: inferred.therapy
                        });
                    } else {
                        result.text = `No momento não encontrei vagas pela ${inferred.period} para ${inferred.therapy}. Nossa equipe vai entrar em contato para encontrar o melhor horário pra vocês 💚`;
                        this.logger.info('SLOT_FETCH_NO_RESULTS', { leadId: lead._id?.toString() });
                    }
                } catch (slotErr) {
                    this.logger.error('SLOT_FETCH_ERROR', { error: slotErr.message });
                    result.text = 'Vou verificar os horários disponíveis e já te retorno! 💚';
                }
            }

            // =========================
            // 🧠 SMART FALLBACK (Amanda 4.2.5)
            // =========================
            const shouldUseSmartFallback = this.shouldTriggerSmartFallback(result, decision);
            
            if (shouldUseSmartFallback) {
                this.logger.info('SMARTFALLBACK_TRIGGERING', {
                    leadId: lead._id?.toString(),
                    reason: 'generic_response_detected',
                    originalText: result?.text?.substring(0, 50),
                    lastHandler: decision.handler,
                    action: decision.action
                });

                try {
                    const { smartFallback } = await import('../services/intelligence/SmartFallback.js');
                    const { getEnrichedContext } = await import('../services/intelligence/contextCache.js');
                    
                    // 🆕 Busca contexto enriquecido (com cache Redis 5min)
                    const enrichedContext = await this.buildEnrichedContext(
                        lead, memoryContext, chatContext, decision
                    );
                    
                    const fallbackResult = await smartFallback({
                        userMessage: message.text,
                        history: memoryContext?.conversationHistory || [],
                        leadData: {
                            _id: lead._id,
                            name: lead.name,
                            therapyArea: lead.therapyArea,
                            patientInfo: lead.patientInfo,
                            primaryComplaint: lead.primaryComplaint
                        },
                        enrichedContext  // 🆕 Dados enriquecidos para cenários 3,7,8,11,13,14
                    });

                    if (fallbackResult.used && fallbackResult.confidence > 0.4) {
                        this.logger.info('SMARTFALLBACK_ACCEPTED', {
                            leadId: lead._id?.toString(),
                            action: fallbackResult.action,
                            confidence: fallbackResult.confidence,
                            newText: fallbackResult.text?.substring(0, 50)
                        });

                        result.text = fallbackResult.text;
                        result.extractedInfo = {
                            ...result.extractedInfo,
                            ...fallbackResult.extractedInfo,
                            smartFallbackMeta: fallbackResult.meta
                        };
                        
                        if (fallbackResult.extractedInfo?.smartFallbackExtracted) {
                            result.extractedInfo.smartFallbackField = fallbackResult.extractedInfo;
                        }
                    } else {
                        this.logger.info('SMARTFALLBACK_REJECTED', {
                            leadId: lead._id?.toString(),
                            confidence: fallbackResult.confidence,
                            reason: 'low_confidence'
                        });
                    }
                } catch (fallbackErr) {
                    this.logger.error('SMARTFALLBACK_ERROR', {
                        leadId: lead._id?.toString(),
                        error: fallbackErr.message
                    });
                    // Continua com resposta original do handler
                }
            }

            // =========================
            // 🔟 GERA RESPOSTA IA SE NECESSÁRIO
            // =========================
            if (result?.needsAIGeneration && result?.promptContext) {
                try {
                    const aiText = await generateHandlerResponse({
                        promptContext: result.promptContext,
                        systemPrompt: null, // Usa SYSTEM_PROMPT_AMANDA padrão
                        lead,
                        memory: memoryContext
                    });

                    result.text = aiText || result.fallbackText || result.text;
                } catch (err) {
                    this.logger.error('AI_GENERATION_ERROR', err);
                    result.text = result.fallbackText || 'Como posso te ajudar? 💚';
                }
            }

            // =========================
            // 1️⃣1️⃣ RETOMADA SE NECESSÁRIO
            // =========================
            if (decision.preserveBookingState && decision.pendingField && result.text) {
                const resumptionText = this.buildResumptionText(missing, decision.pendingField);
                if (resumptionText) {
                    result.text += '\n\n' + resumptionText;
                }
            }

            // =========================
            // 1️⃣2️⃣ PERSISTÊNCIA
            // =========================
            const persistStart = Date.now();
            await this.persistData({
                lead,
                inferred,
                result,
                memoryContext,
                decision
            });
            const persistTime = Date.now() - persistStart;
            this.logger.info('PERSIST_DATA_COMPLETE', {
                leadId: lead._id?.toString(),
                persistTimeMs: persistTime
            });

            // =========================
            // 1️⃣3️⃣ APLICA ANTI-LOOP
            // =========================
            const originalText = result?.text || 'Posso te ajudar com mais alguma coisa? 💚';
            const antiLoopResult = this.applyAntiLoop(
                lead._id.toString(),
                originalText,
                message.text,
                {
                    patientName: memoryContext?.patientName,
                    patientAge: memoryContext?.patientAge,
                    therapyArea: memoryContext?.therapyArea
                }
            );

            // Limpa tracker se agendou ou fez handover
            if (antiLoopResult.action === 'handover' || flags.bookingConfirmed) {
                this.clearLoopTracker(lead._id.toString());
            }

            // =========================
            // 1️⃣4️⃣ RETORNO
            // =========================
            return {
                command: 'SEND_MESSAGE',
                payload: {
                    text: antiLoopResult.text
                },
                meta: antiLoopResult.meta
            };

        } catch (error) {
            this.logger.error('ORCHESTRATOR_ERROR', error);
            
            // 🛡️ Fallback contextual mesmo em erro
            const fallbackText = this.generateContextualFallback(message?.text, {});
            
            return {
                command: 'SEND_MESSAGE',
                payload: {
                    text: fallbackText
                },
                meta: { error: true, fallback: true }
            };
        }
    }

    // =========================
    // MÉTODOS AUXILIARES
    // =========================

    determinePrimaryIntent(flags, intentResult, detectedTherapies) {
        // Prioriza baseado em flags
        if (flags.asksPrice) return 'price';
        if (flags.wantsSchedule) return 'scheduling';
        if (flags.asksPlans) return 'plan_info';
        if (flags.asksAddress) return 'address_info';
        if (flags.asksTherapyInfo) return 'therapy_info';
        if (flags.partnership) return 'partnership';
        if (flags.wantsHumanAgent) return 'human_handoff';

        // Usa intent do detector
        return intentResult.type || 'general_info';
    }

    async extractInferredData({ text, flags, detectedTherapies, intelligent, lead, memoryContext, chatContext }) {
        const textLower = text.toLowerCase();
        const textNormalized = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

        // TERAPIA (cascata + mapper inteligente)
        let therapy = null;

        // 🆕 Usa o mapper robusto do legado se disponível
        if (!therapy && flags) {
            const mapped = mapFlagsToBookingProduct(flags, lead);
            if (mapped?.therapyArea) {
                therapy = mapped.therapyArea;
                this.logger.debug('THERAPY_FROM_MAPPER', { therapy, source: 'bookingProductMapper' });
            }
        }

        // Fallbacks cascata
        // 🆕 DETECTA MÚLTIPLAS TERAPIAS
        const allDetectedTherapies = detectedTherapies.map(t => t.name);
        const hasMultipleTherapies = detectedTherapies.length > 1;

        // 🔧 CORREÇÃO: Carrega terapia do contexto se não achou no texto
        if (!therapy && chatContext?.lastExtractedInfo?.therapy) {
            therapy = chatContext.lastExtractedInfo.therapy;
        }

        // 🔥 NOVO: Carrega info de múltiplas terapias do contexto
        if (chatContext?.lastExtractedInfo?.hasMultipleTherapies) {
            detectedTherapies = chatContext.lastExtractedInfo.allDetectedTherapies?.map(name => ({ name })) || detectedTherapies;
        }

        if (!therapy && detectedTherapies.length > 0) {
            therapy = detectedTherapies[0].name;
        }

        // 🆕 LOG de múltiplas terapias
        if (hasMultipleTherapies) {
            this.logger.info('MULTIPLE_THERAPIES_DETECTED', {
                leadId: lead._id?.toString(),
                therapies: allDetectedTherapies,
                count: detectedTherapies.length,
                selected: therapy
            });
        }
        if (!therapy && intelligent?.especialidade) {
            therapy = intelligent.especialidade;
        }
        if (!therapy && lead?.therapyArea) {
            therapy = lead.therapyArea;
        }
        if (!therapy && memoryContext?.therapyArea) {
            therapy = memoryContext.therapyArea;
        }

        // Verifica estados de aguardo do contexto
        // 🔧 CORREÇÃO: Verifica tanto awaitingField (novo) quanto awaitingComplaint (legado)
        const awaitingFieldFromContext = chatContext?.lastExtractedInfo?.awaitingField;
        const isAwaitingComplaint = awaitingFieldFromContext === 'complaint' || chatContext?.lastExtractedInfo?.awaitingComplaint === true;
        const isAwaitingAge = awaitingFieldFromContext === 'age' || chatContext?.lastExtractedInfo?.awaitingAge === true;
        const isAwaitingPeriod = awaitingFieldFromContext === 'period' || chatContext?.lastExtractedInfo?.awaitingPeriod === true;
        const lastQuestion = chatContext?.lastExtractedInfo?.lastQuestion;

        // 🆕 PROTEÇÃO: Verifica último handler para fallback
        const lastHandlerFromMemory = memoryContext?.lastHandler;
        const lastHandlerFromChat = chatContext?.lastExtractedInfo?.lastHandler;
        const lastHandlerWasComplaint = lastHandlerFromMemory === 'complaintCollectionHandler' ||
            lastHandlerFromChat === 'complaintCollectionHandler';

        // 🐛 DEBUG: Log detalhado do estado de aguardo
        this.logger.debug('EXTRACT_INFERRED_CONTEXT_STATE', {
            leadId: lead._id?.toString(),
            isAwaitingComplaint,
            isAwaitingAge,
            isAwaitingPeriod,
            lastHandlerFromMemory,
            lastHandlerFromChat,
            lastHandlerWasComplaint,
            chatContextLastExtracted: chatContext?.lastExtractedInfo,
            text: text?.substring(0, 100)
        });

        // 🧠 Determina qual campo estamos aguardando para extração semântica
        // 🆕 Também considera o último handler como fallback
        const awaitingField = isAwaitingAge ? 'age'
            : (isAwaitingComplaint || lastHandlerWasComplaint) ? 'complaint'
                : isAwaitingPeriod ? 'period'
                    : !therapy ? 'therapy'
                        : null;

        // IDADE - Extrai de formas naturais
        // 🔧 CORREÇÃO: Também carrega do chatContext (dados salvos na mensagem anterior)
        let age = intelligent?.idade || intelligent?.age || lead?.patientInfo?.age || chatContext?.lastExtractedInfo?.age;
        if (typeof age === 'string') age = parseInt(age, 10);
        if (isNaN(age)) age = null;

        // 🔥 EXPERTISE: Se não achou idade via regex padrão, tenta padrões mais naturais
        if (!age) {
            // "ele tem 2 anos", "minha filha tem 5", "tem 3 aninhos", "2 anos de idade"
            const agePatterns = [
                /(?:ele|ela|crian[çc]a|filho|filha|paciente|bebe?)?\s*(?:tem|tem\s+aproximadamente)?\s*(\d+)\s*(?:anos?|aninhos?|a)(?:\s*de\s*idade)?/i,
                /(\d+)\s*(?:anos?|aninhos?)(?:\s*de\s*idade)?/i,
                /(?:idade|anos?)\s*(?:de)?\s*(\d+)/i
            ];

            for (const pattern of agePatterns) {
                const match = text.match(pattern);
                if (match) {
                    age = parseInt(match[1], 10);
                    if (!isNaN(age) && age > 0 && age < 120) {
                        this.logger.debug('AGE_EXTRACTED_NATURALLY', { age, pattern: pattern.toString() });
                        break;
                    }
                }
            }
        }

        // Se estava aguardando idade e não achou, tenta extração semântica
        if (!age && isAwaitingAge && awaitingField === 'age') {
            // Primeiro tenta número isolado (rápido)
            const isolatedNumber = text.match(/\b(\d{1,2})\b/);
            if (isolatedNumber) {
                const possibleAge = parseInt(isolatedNumber[1], 10);
                if (possibleAge > 0 && possibleAge < 120) {
                    age = possibleAge;
                    this.logger.debug('AGE_EXTRACTED_FROM_CONTEXT', { age, reason: 'awaiting_age_state' });
                }
            }

            // 🧠 Se ainda não achou, usa IA (Groq grátis) para interpretar
            if (!age) {
                const semanticResult = await smartExtract(text, 'age', {
                    lastAmandaMessage: chatContext?.lastAmandaMessage || memoryContext?.lastAmandaMessage
                });
                if (semanticResult?.age) {
                    age = semanticResult.age;
                    this.logger.debug('AGE_EXTRACTED_SEMANTICALLY', {
                        age,
                        text,
                        source: 'smartExtract'
                    });
                }
            }
        }

        // PERÍODO - Extrai de formas variadas
        // 🔧 CORREÇÃO: Também carrega do chatContext (dados salvos na mensagem anterior)
        let period = intelligent?.disponibilidade || intelligent?.preferredPeriod || chatContext?.lastExtractedInfo?.period;
        if (!period) {
            if (/\b(manh[aã]|manhacinho|cedo|in[ií]cio\s+dia|parte\s+da\s+manh[aã])\b/i.test(textNormalized)) period = 'manha';
            else if (/\b(tard|tarde|depois\s+do\s+almo[çc]o|inicio\s+tarde|fim\s+tarde)\b/i.test(textNormalized)) period = 'tarde';
            else if (/\b(noit|noite|final\s+dia|depois\s+das?\s*\d+)\b/i.test(textNormalized)) period = 'noite';
        }
        period = normalizePeriod(period);

        // Se estava aguardando período e não achou, tenta interpretar mais flexivelmente
        if (!period && isAwaitingPeriod && awaitingField === 'period') {
            if (/\b(manh[aã]|manhacinho|cedo|antes\s+do\s+almo[çc]o|pela\s+manh[aã])\b/i.test(textLower)) period = 'manha';
            else if (/\b(tard|tarde|depois\s+do\s+almo[çc]o|pela\s+tarde)\b/i.test(textLower)) period = 'tarde';
            else if (/\b(noit|noite|pela\s+noite)\b/i.test(textLower)) period = 'noite';

            if (period) {
                this.logger.debug('PERIOD_EXTRACTED_FROM_CONTEXT', { period, reason: 'awaiting_period_state' });
            }

            // 🧠 Fallback semântico para período
            if (!period) {
                const semanticResult = await smartExtract(text, 'period', {
                    lastAmandaMessage: chatContext?.lastAmandaMessage || memoryContext?.lastAmandaMessage
                });
                if (semanticResult?.period) {
                    period = semanticResult.period;
                    this.logger.debug('PERIOD_EXTRACTED_SEMANTICALLY', {
                        period,
                        text,
                        source: 'smartExtract'
                    });
                }
            }
        }

        // QUEIXA - Verifica se há queixa salva ou se estamos aguardando uma
        // 🔧 CORREÇÃO: Também carrega do chatContext (dados salvos na mensagem anterior)
        let complaint = intelligent?.queixa || lead?.primaryComplaint || chatContext?.lastExtractedInfo?.complaint;

        // 🆕 PROTEÇÃO: já definido acima, reusa a variável
        const shouldExtractComplaint = isAwaitingComplaint || lastHandlerWasComplaint;

        // 🐛 DEBUG: Estado antes da extração
        this.logger.debug('COMPLAINT_EXTRACTION_START', {
            hasIntelligent: !!intelligent?.queixa,
            hasLeadComplaint: !!lead?.primaryComplaint,
            isAwaitingComplaint,
            lastHandlerWasComplaint,
            shouldExtractComplaint,
            awaitingField
        });

        // 🔥 EXPERTISE: Se estamos aguardando uma queixa E/OU o texto parece uma descrição de problema
        // 🔧 CORREÇÃO: Extrai queixa automaticamente se o texto parece uma descrição de sintoma/queixa
        // 🔥 IMPORTANTE: Sempre verifica se o texto atual parece uma queixa, mesmo se já tiver uma no contexto
        const looksLikeComplaint =
            text.length > 10 &&
            text.length < 300 &&
            !/^\s*(sim|não|não sei|ok|beleza|tudo bem|oi|olá|bom dia|boa tarde)\s*$/i.test(text) &&
            !text.trim().endsWith('?') &&
            (/\b(tem|tenho|meu|minha|filho|filha|ele|ela|não|dificuldade|problema|sintoma|queixa|dor|medo|ansiedade|atraso|demora)\b/i.test(text));

        // 🆕 FIX BUG 3: Não extrair como queixa se é pergunta direta sobre planos/preço/endereço
        const isDirectQuestion = flags.asksPlans || flags.asksPrice || flags.asksAddress || 
                                  flags.asksPayment || flags.wantsHumanAgent ||
                                  /\b(aceitam?|tem|fazem?|vocês?|vcs)\b.*\b(plano|convênio|unimed|amil|hapvida|sul\s?america)/i.test(text);

        if ((looksLikeComplaint || (!complaint && shouldExtractComplaint && awaitingField === 'complaint')) && !isDirectQuestion) {
            const isQuestion = /\?$/.test(text.trim()) || /^(qual|quanto|onde|como|por que|pq|quando)\b/i.test(text);
            const isTooShort = text.trim().length < 5;
            const isGenericResponse = /^(sim|n[aã]o|ok|beleza|tudo bem|n sei|não sei|nao sei|nao|não|n sei|dunno)$/i.test(text.trim());

            this.logger.debug('COMPLAINT_VALIDATION', {
                isQuestion,
                isTooShort,
                isGenericResponse,
                looksLikeComplaint,
                textLength: text.trim().length,
                text: text.trim().substring(0, 50)
            });

            if (!isQuestion && !isTooShort && !isGenericResponse) {
                complaint = text.trim().substring(0, 200);
                this.logger.info('COMPLAINT_EXTRACTED_FROM_CONTEXT', {
                    text: complaint,
                    reason: looksLikeComplaint ? 'looks_like_complaint' : 'awaiting_complaint_state'
                });
            }

            // 🧠 Se ainda não extraiu, usa IA para interpretar a queixa
            if (!complaint && !looksLikeComplaint) {
                this.logger.debug('COMPLAINT_TRYING_SEMANTIC', { reason: 'no_regex_match' });
                const semanticResult = await smartExtract(text, 'complaint', {
                    lastAmandaMessage: chatContext?.lastAmandaMessage || memoryContext?.lastAmandaMessage
                });
                if (semanticResult?.complaint) {
                    complaint = semanticResult.complaint;
                    this.logger.info('COMPLAINT_EXTRACTED_SEMANTICALLY', {
                        complaint,
                        text,
                        source: 'smartExtract'
                    });
                }
            }
        }

        // 🐛 DEBUG: Resultado final
        this.logger.debug('COMPLAINT_EXTRACTION_RESULT', {
            extracted: !!complaint,
            complaint: complaint?.substring(0, 50)
        });

        // Data preferida
        const preferredDate = extractPreferredDateFromText(text);

        return {
            therapy,
            age,
            period,
            complaint,
            preferredDate,
            detectedTherapies: detectedTherapies.map(t => t.id),
            // 🆕 MÚLTIPLAS TERAPIAS
            allDetectedTherapies,
            hasMultipleTherapies,
            needsTherapySelection: hasMultipleTherapies && !chatContext?.lastExtractedInfo?.selectedTherapy
        };
    }

    async buildBookingContext({ lead, memoryContext, text, inferred }) {
        const bookingContext = {};

        // Slots pendentes
        if (memoryContext?.pendingSchedulingSlots?.primary) {
            bookingContext.slots = memoryContext.pendingSchedulingSlots;
        }

        // Slot escolhido
        if (memoryContext?.chosenSlot?.doctorId) {
            bookingContext.chosenSlot = memoryContext.chosenSlot;
        }

        // Verifica se há escolha de slot na mensagem
        if (bookingContext.slots) {
            const chosen = pickSlotFromUserReply(text, bookingContext.slots, { strict: true });
            if (chosen) {
                const validation = await validateSlotStillAvailable(chosen, {
                    therapyArea: inferred.therapy,
                    preferredPeriod: inferred.period
                });

                if (validation?.isValid) {
                    bookingContext.chosenSlot = chosen;
                    await Leads.findByIdAndUpdate(lead._id, {
                        $set: { pendingChosenSlot: chosen },
                        $unset: { pendingSchedulingSlots: "" }
                    });
                } else {
                    bookingContext.slotGone = true;
                    bookingContext.alternatives = validation?.freshSlots;
                }
            }
        }

        // Data preferida
        if (inferred.preferredDate) {
            bookingContext.preferredDate = inferred.preferredDate;
        }

        return bookingContext;
    }

    calculateMissing({ lead, inferred, bookingContext, flags }) {
        const patientName = lead?.patientInfo?.name || lead?.autoBookingContext?.patientName;

        return {
            needsTherapy: !inferred.therapy,
            needsTherapySelection: inferred.hasMultipleTherapies || inferred.needsTherapySelection,
            needsComplaint: !inferred.complaint,  // 🔥 SEMPRE precisa da queixa!
            needsAge: !inferred.age,
            needsPeriod: !inferred.period,
            needsSlot: !bookingContext?.slots?.primary && !bookingContext?.chosenSlot,
            needsSlotSelection: bookingContext?.slots?.primary && !bookingContext?.chosenSlot,
            needsName: bookingContext?.chosenSlot && !patientName,
            currentAwaiting: this.determineCurrentAwaiting({ inferred, bookingContext, patientName })
        };
    }

    determineCurrentAwaiting({ inferred, bookingContext, patientName }) {
        if (!inferred.therapy) return 'therapy';
        if (!inferred.complaint) return 'complaint';
        if (!inferred.age) return 'age';
        if (!inferred.period) return 'period';
        if (bookingContext?.slots?.primary && !bookingContext?.chosenSlot) return 'slot_selection';
        if (bookingContext?.chosenSlot && !patientName) return 'name';
        return null;
    }

    buildResumptionText(missing, pendingField) {
        const messages = {
            therapy: 'Voltando ao agendamento: qual área você procura?',
            complaint: 'Sobre o agendamento: me conta rapidinho a situação principal?',
            age: 'Para o agendamento: qual a idade?',
            period: 'Para verificar horários: prefere manhã ou tarde?',
            slot_selection: 'Qual dos horários funciona melhor pra você?',
            name: 'Só preciso do nome completo para confirmar:'
        };
        return messages[pendingField] || 'Voltando ao que estávamos falando...';
    }

    async persistData({ lead, inferred, result, memoryContext, decision }) {
        const set = {};
        const unset = {};

        // 🐛 DEBUG: Log dos dados a serem persistidos
        this.logger.info('PERSIST_DATA_START', {
            leadId: lead._id?.toString(),
            inferred: {
                therapy: inferred.therapy,
                age: inferred.age,
                complaint: inferred.complaint?.substring(0, 50),
                period: inferred.period
            },
            extractedInfo: result?.extractedInfo
        });

        // Dados inferidos
        if (inferred.therapy) set.therapyArea = inferred.therapy;
        if (inferred.age) set["patientInfo.age"] = inferred.age;
        if (inferred.complaint) set.primaryComplaint = inferred.complaint;
        if (inferred.period) set.pendingPreferredPeriod = inferred.period;

        // Dados do resultado do handler
        if (result?.extractedInfo?.patientName) {
            set["patientInfo.name"] = result.extractedInfo.patientName;
        }

        // Espelha no qualificationData
        if (inferred.therapy) set["qualificationData.extractedInfo.therapyArea"] = inferred.therapy;
        if (inferred.age) set["qualificationData.extractedInfo.idade"] = inferred.age;
        if (inferred.period) set["qualificationData.extractedInfo.disponibilidade"] = inferred.period;
        if (inferred.complaint) set["qualificationData.extractedInfo.queixa"] = inferred.complaint;

        // 🆕 FIX BUG 5b: Sempre atualiza lastContactAt para warm recall funcionar
        set.lastContactAt = new Date();

        // 🆕 FIX BUG 4: Persiste intent score e modo de conversação do DecisionEngine
        if (decision?._v42?.updates) {
            const v42Updates = decision._v42.updates;
            for (const [key, value] of Object.entries(v42Updates)) {
                if (value !== undefined && value !== null) {
                    set[key] = value;
                }
            }
            this.logger.info('V42_UPDATES_PERSISTED', {
                leadId: lead._id?.toString(),
                keys: Object.keys(v42Updates),
                intentScore: decision._v42?.intentScore
            });
        }

        // Salva no lead
        if (Object.keys(set).length > 0) {
            this.logger.info('PERSIST_DATA_SAVING_LEAD', {
                leadId: lead._id?.toString(),
                fields: Object.keys(set)
            });
            await Leads.findByIdAndUpdate(lead._id, { $set: set });
            this.logger.info('PERSIST_DATA_SAVED_LEAD', { leadId: lead._id?.toString() });
        } else {
            this.logger.info('PERSIST_DATA_NO_FIELDS_TO_SAVE', { leadId: lead._id?.toString() });
        }

        // 🆕 Atualiza contexto COMBINANDO extractedInfo + dados inferidos + lastHandler
        // 🔧 CORREÇÃO: Agora incluímos os dados inferidos (idade, terapia, período, queixa)
        // para que na próxima mensagem o orquestrador saiba que já tem esses dados
        const contextUpdate = {
            ...(result?.extractedInfo || {}),
            // 🔧 CORREÇÃO: Salvar dados inferidos no contexto para recuperar na próxima mensagem
            ...(inferred.age && { age: inferred.age }),
            ...(inferred.therapy && { therapy: inferred.therapy }),
            ...(inferred.period && { period: inferred.period }),
            ...(inferred.complaint && { complaint: inferred.complaint }),
            // 🔥 NOVO: Salvar info de múltiplas terapias
            ...(inferred.hasMultipleTherapies && { hasMultipleTherapies: inferred.hasMultipleTherapies }),
            ...(inferred.allDetectedTherapies && { allDetectedTherapies: inferred.allDetectedTherapies }),
            ...(inferred.detectedTherapies && { detectedTherapies: inferred.detectedTherapies }),
            ...(decision?.handler && { lastHandler: decision.handler })
        };

        if (Object.keys(contextUpdate).length > 0) {
            this.logger.info('CONTEXT_MEMORY_UPDATE', {
                leadId: lead._id?.toString(),
                keys: Object.keys(contextUpdate),
                awaitingComplaint: contextUpdate.awaitingComplaint,
                lastHandler: contextUpdate.lastHandler
            });
            await ContextMemory.update(lead._id, contextUpdate);
        }

        // 🆕 Limpa os estados de aguardo quando os dados são extraídos com sucesso
        // para evitar que mensagens futuras sejam tratadas indevidamente
        const unsetStates = {};
        if (inferred.complaint) {
            unsetStates["lastExtractedInfo.awaitingComplaint"] = "";
            unsetStates["lastExtractedInfo.lastQuestion"] = "";
        }
        if (inferred.age) {
            unsetStates["lastExtractedInfo.awaitingAge"] = "";
            if (!inferred.complaint) unsetStates["lastExtractedInfo.lastQuestion"] = "";
        }
        if (inferred.period) {
            unsetStates["lastExtractedInfo.awaitingPeriod"] = "";
            if (!inferred.complaint && !inferred.age) unsetStates["lastExtractedInfo.lastQuestion"] = "";
        }

        if (Object.keys(unsetStates).length > 0) {
            await ChatContext.findOneAndUpdate(
                { lead: lead._id },
                { $unset: unsetStates }
            );
        }

        if (inferred.slotConfirmed) {
            unsetStates["lastExtractedInfo.awaitingField"] = "";
            unsetStates["lastExtractedInfo.slot_confirmation"] = "";
        }

        // 🆕 SALVAR INSIGHTS DO LEAD (painAcknowledged, objections, interests)
        await this.saveLeadInsights({ lead, result, memoryContext, decision });

        // Gera resumo se necessário
        try {
            const totalMessages = memoryContext?.conversationHistory?.length || 0;
            if (needsNewSummary(lead, totalMessages, [])) {
                const messages = memoryContext?.conversationHistory?.slice(-30) || [];
                const summary = await generateConversationSummary(messages);
                if (summary) {
                    await Leads.findByIdAndUpdate(lead._id, {
                        $set: {
                            conversationSummary: summary,
                            summaryGeneratedAt: new Date()
                        }
                    });
                }
            }
        } catch (e) {
            this.logger.warn('SUMMARY_ERROR', e.message);
        }
    }

    /**
     * 🆕 SALVAR INSIGHTS DO LEAD
     * Salva painAcknowledged, objections, interests para personalização futura
     */
    async saveLeadInsights({ lead, result, memoryContext, decision }) {
        try {
            const insights = {};
            const pushInsights = {};
            
            // Pain Acknowledged
            if (result?.extractedInfo?.painAcknowledged || 
                decision?.action === 'acknowledge_pain' ||
                decision?.action === 'developmental_urgency') {
                insights["qualificationData.painAcknowledged"] = true;
                insights["qualificationData.painAcknowledgedAt"] = new Date();
            }
            
            // Objeções detectadas
            if (result?.extractedInfo?.objections?.length > 0) {
                // Adiciona objeções ao array sem duplicar
                for (const objection of result.extractedInfo.objections) {
                    pushInsights["qualificationData.objections"] = {
                        type: objection,
                        detectedAt: new Date()
                    };
                }
            }
            
            // Interesses detectados
            if (result?.extractedInfo?.interests?.length > 0) {
                for (const interest of result.extractedInfo.interests) {
                    pushInsights["qualificationData.interests"] = {
                        type: interest,
                        detectedAt: new Date()
                    };
                }
            }
            
            // Emotional markers
            const emotionalMarkers = memoryContext?.emotionalMarkers;
            if (emotionalMarkers) {
                if (emotionalMarkers.expressedWorry) {
                    insights["qualificationData.expressedWorry"] = true;
                }
                if (emotionalMarkers.expressedUrgency) {
                    insights["qualificationData.expressedUrgency"] = true;
                }
                if (emotionalMarkers.expressedFrustration) {
                    insights["qualificationData.expressedFrustration"] = true;
                }
            }
            
            // Warm lead info
            if (decision?.action === 'warm_lead_close') {
                insights["qualificationData.warmLeadScenario"] = result?.extractedInfo?.scenario;
                insights["qualificationData.warmLeadDetectedAt"] = new Date();
            }
            
            // 🆕 CONVERSATION OUTCOME (Analytics inteligente)
            const outcome = determineConversationOutcome({
                result, 
                decision, 
                memoryContext, 
                previousOutcome: lead?.qualificationData?.conversationOutcome
            });
            
            if (outcome) {
                insights["qualificationData.conversationOutcome"] = outcome.type;
                insights["qualificationData.outcomeDetectedAt"] = new Date();
                insights["qualificationData.outcomeScore"] = outcome.score || 0;
                
                this.logger.info('CONVERSATION_OUTCOME_DETECTED', {
                    leadId: lead._id?.toString(),
                    outcome: outcome.type,
                    score: outcome.score
                });
            }
            
            // Atualizar lead
            if (Object.keys(insights).length > 0 || Object.keys(pushInsights).length > 0) {
                const updateOps = {};
                if (Object.keys(insights).length > 0) updateOps.$set = insights;
                if (Object.keys(pushInsights).length > 0) updateOps.$push = pushInsights;
                
                await Leads.findByIdAndUpdate(lead._id, updateOps);
                
                this.logger.info('LEAD_INSIGHTS_SAVED', {
                    leadId: lead._id?.toString(),
                    insights: Object.keys(insights),
                    pushCount: Object.keys(pushInsights).length
                });
            }
        } catch (error) {
            this.logger.error('SAVE_INSIGHTS_ERROR', {
                leadId: lead._id?.toString(),
                error: error.message
            });
        }
    }

    // ============================================================================
    // 🛡️ SISTEMA ANTI-LOOP E FALLBACK CONTEXTUAL (Amanda 4.2.2)
    // ============================================================================

    /**
     * 🔄 Verifica se Amanda entrou em loop (mesma resposta repetida)
     * @param {string} leadId - ID do lead
     * @param {string} currentText - Texto atual da Amanda
     * @returns {Object} Status do loop
     */
    checkLoopStatus(leadId, currentText) {
        // Inicializa tracking se não existir
        if (!this.loopTracker) this.loopTracker = new Map();
        if (!this.loopTracker.has(leadId)) {
            this.loopTracker.set(leadId, {
                lastTexts: [],
                identicalCount: 0,
                fallbackAttempts: 0
            });
        }

        const tracker = this.loopTracker.get(leadId);
        const normalizedText = currentText?.toLowerCase()?.trim();

        // Verifica se é idêntica às últimas 2 mensagens
        const isIdentical = tracker.lastTexts.some(
            text => text?.toLowerCase()?.trim() === normalizedText
        );

        if (isIdentical) {
            tracker.identicalCount++;
            this.logger.warn('LOOP_DETECTED', {
                leadId,
                identicalCount: tracker.identicalCount,
                text: currentText?.substring(0, 50)
            });
        } else {
            tracker.identicalCount = 0;
        }

        // Mantém só as últimas 3 mensagens
        tracker.lastTexts.push(normalizedText);
        if (tracker.lastTexts.length > 3) tracker.lastTexts.shift();

        return {
            isLooping: tracker.identicalCount >= 1,
            loopCount: tracker.identicalCount,
            needsEscalation: tracker.identicalCount >= 2,
            tracker
        };
    }

    /**
     * 💡 Gera fallback contextual baseado na mensagem do usuário
     * @param {string} userMessage - Última mensagem do usuário
     * @param {Object} context - Contexto do lead
     * @returns {string} Resposta contextual
     */
    generateContextualFallback(userMessage, context = {}) {
        const text = userMessage?.toLowerCase() || '';

        // Fallback por palavras-chave
        const fallbackMap = [
            {
                keywords: ['exame', 'avaliação', 'teste', 'consulta'],
                responses: [
                    'Fazemos sim! Para poder te passar as informações certas, me conta: é para criança ou adulto? E qual a idade? 💚',
                    'Claro! Realizamos avaliações. Qual seria a faixa etária e o que vocês precisam? 💚',
                    'Sim! Atendemos várias especialidades. Me conta um pouco sobre quem precisa do atendimento? 💚'
                ]
            },
            {
                keywords: ['preço', 'valor', 'custa', 'quanto'],
                responses: [
                    'Posso te passar os valores! Temos sessão avulsa e pacotes com desconto. Qual área você precisa? Fonoaudiologia, psicologia...? 💚',
                    'Claro! Os valores dependem da especialidade. Qual terapia você procura? 💚',
                    'Sessão avulsa é R$ 200, pacote 4x sai R$ 180 cada. Posso verificar disponibilidade pra você! Qual área? 💚'
                ]
            },
            {
                keywords: ['horário', 'agendar', 'marcar', 'vaga'],
                responses: [
                    'Tenho horários disponíveis! Prefere manhã ou tarde? E qual dia da semana funciona melhor? 💚',
                    'Posso marcar para você! Temos horários de segunda a sábado. Qual seu melhor horário? 💚',
                    'Vamos encontrar um horário! Você prefere pela manhã ou à tarde? 💚'
                ]
            },
            {
                keywords: ['plano', 'convênio', 'amil', 'unimed', 'bradesco'],
                responses: [
                    'Trabalhamos com reembolso! Você paga e solicita o reembolso na sua operadora. Quer saber mais sobre como funciona? 💚',
                    'Não temos convênio direto, mas emitimos todos os documentos para reembolso. Funciona bem! Quer conhecer nossos horários? 💚'
                ]
            },
            {
                keywords: ['não fala', 'atraso', 'autismo', 'tea', 'tdah'],
                responses: [
                    'Entendo, isso é mais comum do que parece e tratamos muitos casos assim. Qual a idade? Posso indicar o melhor profissional 💚',
                    'Muitos pais vêm com essa mesma preocupação. Temos especialistas nessa área! Qual a idade da criança? 💚',
                    'A gente pode ajudar sim! Atendemos várias crianças com essa característica. Quer marcar uma avaliação? 💚'
                ]
            }
        ];

        // Procura match
        for (const category of fallbackMap) {
            if (category.keywords.some(kw => text.includes(kw))) {
                // Retorna uma resposta aleatória da categoria
                return category.responses[Math.floor(Math.random() * category.responses.length)];
            }
        }

        // Fallback genérico variado (nunca repete igual)
        const genericResponses = [
            'Oi! Me conta um pouco sobre o que você precisa? Quero te ajudar da melhor forma 💚',
            'Claro! Para eu poder te orientar melhor, qual a situação que vocês estão vivendo? 💚',
            'Posso ajudar com isso! Me conta: é para criança ou adulto? E qual a faixa etária? 💚',
            'Vou te ajudar! Qual seria o objetivo do atendimento? 💚',
            'Oi! Para passar as informações certas, me conta um pouco sobre quem precisa 💚'
        ];

        return genericResponses[Math.floor(Math.random() * genericResponses.length)];
    }

    /**
     * 🚨 Mensagem de escalada quando o loop persiste
     * @param {Object} context - Contexto do lead
     * @returns {string} Mensagem de handover
     */
    generateEscalationMessage(context = {}) {
        const { patientName, patientAge, therapyArea } = context;
        
        const escalationResponses = [
            'Oi! Acho que talvez não esteja conseguindo te ajudar da melhor forma por aqui. Vou passar para uma de nossas atendentes que vão conseguir te atender melhor, tá bom? 💚',
            'Percebi que talvez você precise de um atendimento mais específico. Vou pedir para uma de nossas atendentes entrar em contato com você, pode ser? 💚',
            'Oi! Para poder te ajudar melhor, vou pedir para uma de nossas atendentes te chamar aqui, tá? 💚'
        ];

        return escalationResponses[Math.floor(Math.random() * escalationResponses.length)];
    }

    /**
     * 🎭 Wrapper que aplica anti-loop antes de enviar mensagem
     * @param {string} leadId - ID do lead
     * @param {string} proposedText - Texto proposto pela Amanda
     * @param {string} userMessage - Última mensagem do usuário
     * @param {Object} context - Contexto
     * @returns {Object} Texto final e metadata
     */
    applyAntiLoop(leadId, proposedText, userMessage, context = {}) {
        const loopStatus = this.checkLoopStatus(leadId, proposedText);

        // Se está em loop, gera fallback contextual
        if (loopStatus.isLooping) {
            this.logger.info('APPLYING_ANTI_LOOP', {
                leadId,
                loopCount: loopStatus.loopCount,
                originalText: proposedText?.substring(0, 50)
            });

            // Se já tentou 2x, escala para humano
            if (loopStatus.needsEscalation) {
                return {
                    text: this.generateEscalationMessage(context),
                    action: 'handover',
                    meta: { loopDetected: true, escalated: true }
                };
            }

            // Gera fallback contextual
            return {
                text: this.generateContextualFallback(userMessage, context),
                action: 'fallback',
                meta: { loopDetected: true, fallback: true }
            };
        }

        // Sem loop, retorna texto original
        return {
            text: proposedText,
            action: 'normal',
            meta: { loopDetected: false }
        };
    }

    /**
     * 🧹 Limpa tracking de loop (chamar quando conversa termina ou agenda)
     * @param {string} leadId - ID do lead
     */
    clearLoopTracker(leadId) {
        if (this.loopTracker?.has(leadId)) {
            this.loopTracker.delete(leadId);
            this.logger.info('LOOP_TRACKER_CLEARED', { leadId });
        }
    }

    /**
     * 🧠 Detecta quando deve acionar SmartFallback (Amanda 4.2.5)
     * 
     * @param {Object} result - Resultado do handler
     * @param {Object} decision - Decisão do DecisionEngine
     * @returns {boolean} Se deve usar SmartFallback
     */
    shouldTriggerSmartFallback(result, decision) {
        // Se não tem resultado, não há o que melhorar
        if (!result?.text) return false;

        const text = result.text.toLowerCase().trim();
        const action = decision?.action;

        // 🎯 Padrões de resposta genérica que indicam "não sei o que fazer"
        const genericPatterns = [
            /^como posso te ajudar\?.*$/,
            /^como posso ajudar.*$/,
            /^me conta um pouquinho mais.*$/,
            /^o que você precisa.*$/,
            /^posso te ajudar.*$/,
            /^posso ajudar.*$/,
            /^em que posso ajudar.*$/,
            /^como posso te ajudar hoje.*$/,
            /^me fala mais sobre.*$/
        ];

        const isGenericResponse = genericPatterns.some(pattern => pattern.test(text));

        // 🎯 Situações específicas que indicam confusão
        const isConfusedSituation = (
            // Handler retornou continue_collection mas sem awaitingField definido
            (action === 'continue_collection' && !result?.extractedInfo?.awaitingField) ||
            // Resposta muito curta em situação complexa
            (text.length < 30 && action === 'continue_collection') ||
            // Repetindo a mesma pergunta genérica
            (isGenericResponse && action === 'continue_collection')
        );

        // 🎯 NÃO usar SmartFallback quando:
        const shouldSkip = (
            // É uma ação específica (não genérica)
            ['show_slots', 'schedule', 'warm_recall', 'handle_objection', 'acknowledge_pain'].includes(action) ||
            // Já tem dados suficientes sendo processados
            (result?.extractedInfo?.offeredSlots) ||
            // É smart_response com texto substancial
            (action === 'smart_response' && text.length > 50) ||
            // Handler já marcou que usou IA
            (result?.extractedInfo?.smartFallbackUsed) ||
            // É warm_recall
            (action === 'warm_recall')
        );

        if (shouldSkip) {
            this.logger.debug('SMARTFALLBACK_SKIPPED', {
                action,
                reason: 'specific_action_or_already_processed',
                text: text.substring(0, 30)
            });
            return false;
        }

        if (isGenericResponse || isConfusedSituation) {
            this.logger.info('SMARTFALLBACK_DETECTED_GENERIC', {
                action,
                text: text.substring(0, 50),
                isGenericResponse,
                isConfusedSituation,
                hasAwaitingField: !!result?.extractedInfo?.awaitingField
            });
            return true;
        }

        return false;
    }

    /**
     * 🏗️ Build Enriched Context - Busca dados adicionais para SmartFallback
     * Com cache Redis 5min para performance
     */
    async buildEnrichedContext(lead, memoryContext, chatContext, decision) {
        const { getEnrichedContext } = await import('../services/intelligence/contextCache.js');
        
        return getEnrichedContext(lead._id.toString(), async () => {
            const enriched = {
                lastContext: chatContext?.lastExtractedInfo || {},
                lastAmandaMessage: memoryContext?.lastAmandaMessage,
                lastHandler: decision.handler,
                objectionsHistory: lead?.qualificationData?.objections?.map(o => o.type) || [],
                warmLeadStatus: lead?.qualificationData?.warmLeadScenario || null
            };

            // 🕐 Calcula tempo desde última interação (para cenário 3: Warm Recall)
            const lastInteraction = lead?.qualificationData?.lastIntentUpdate || 
                                   lead?.updatedAt || 
                                   memoryContext?.lastInteraction;
            
            if (lastInteraction) {
                const hoursSince = (Date.now() - new Date(lastInteraction).getTime()) / (1000 * 60 * 60);
                enriched.hoursSinceLastContact = Math.round(hoursSince);
            }

            // 🏥 Busca appointments (para cenários 11, 13: Retorno / Já é paciente)
            try {
                const { default: Appointment } = await import('../models/Appointment.js');
                
                const appointments = await Appointment.find({
                    lead: lead._id,
                    status: { $in: ['completed', 'confirmed', 'scheduled'] }
                })
                .select('date therapyArea status doctorName')
                .sort({ date: -1 })
                .limit(5)
                .lean();

                enriched.isExistingPatient = appointments.length > 0;
                enriched.recentAppointments = appointments.map(a => ({
                    date: a.date,
                    therapyArea: a.therapyArea,
                    status: a.status,
                    doctorName: a.doctorName
                }));

                this.logger.debug('ENRICHED_CONTEXT_APPOINTMENTS', {
                    leadId: lead._id?.toString(),
                    count: appointments.length,
                    isExistingPatient: enriched.isExistingPatient
                });

            } catch (err) {
                this.logger.warn('ENRICHED_CONTEXT_APPOINTMENTS_ERROR', {
                    leadId: lead._id?.toString(),
                    error: err.message
                });
                enriched.isExistingPatient = false;
                enriched.recentAppointments = [];
            }

            this.logger.info('ENRICHED_CONTEXT_BUILT', {
                leadId: lead._id?.toString(),
                hoursSinceLastContact: enriched.hoursSinceLastContact,
                isExistingPatient: enriched.isExistingPatient,
                appointmentsCount: enriched.recentAppointments?.length,
                objectionsCount: enriched.objectionsHistory?.length
            });

            return enriched;
        });
    }
}

export default WhatsAppOrchestrator;
