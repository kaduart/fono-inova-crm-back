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
                memory: mergedMemory,  // Usar memory mesclado!
                flags,  // 🔥 FALTAVA ISSO! Passando flags para o DecisionEngine
                missing,
                urgency,
                bookingContext,
                clinicalRules,
                lead,
                message: { text },
                chatContext
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
            // 1️⃣3️⃣ RETORNO
            // =========================
            return {
                command: 'SEND_MESSAGE',
                payload: {
                    text: result?.text || 'Posso te ajudar com mais alguma coisa? 💚'
                }
            };

        } catch (error) {
            this.logger.error('ORCHESTRATOR_ERROR', error);
            return {
                command: 'SEND_MESSAGE',
                payload: {
                    text: 'Oi! Poderia me repetir o que você precisa? Quero ter certeza de entender direito para te ajudar 💚'
                },
                meta: { error: true }
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

        if (looksLikeComplaint || (!complaint && shouldExtractComplaint && awaitingField === 'complaint')) {
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

        if (inferred.slotConfirmed || text.toLowerCase().match(/^(sim|ok|pode ser|confirmo|isso)/)) {
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
}

export default WhatsAppOrchestrator;
