import Logger from '../services/utils/Logger.js';

// Memory & Context
import * as ContextMemory from '../services/intelligence/contextMemory.js';
import { buildContextPack } from '../services/intelligence/ContextPack.js';
import enrichLeadContext from '../services/leadContext.js';

// Intelligence
import { analyzeLeadMessage } from '../services/intelligence/leadIntelligence.js';
import { nextStage } from '../services/intelligence/stageEngine.js';

// Booking utils
import {
    findAvailableSlots,
    pickSlotFromUserReply,
    validateSlotStillAvailable
} from '../services/amandaBookingService.js';

// Clinical rules
import { clinicalRulesEngine } from '../services/intelligence/clinicalRulesEngine.js';
import { calculateUrgency } from '../services/intelligence/UrgencyScheduler.js';

// Handlers
import IntentDetector from '../detectors/IntentDetector.js';
import * as handlers from '../handlers/index.js';
import Leads from '../models/Leads.js';
import { decisionEngine } from '../services/intelligence/DecisionEngine.js';
import { normalizePeriod } from '../utils/normalizePeriod.js';
import { generateHandlerResponse } from '../services/aiAmandaService.js';

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
        // helper (perto do topo do process)
        const normalizeSentinel = (v) => {
            if (v == null) return null;
            if (typeof v === 'string') {
                const s = v.trim().toLowerCase();
                if (s === 'não' || s === 'nao' || s === 'n/a' || s === 'no') return null;
            }
            return v;
        };

        try {
            const text = message?.content || message?.text || '';

            // =========================
            // 1) MEMÓRIA & CONTEXTO
            // =========================
            const memoryContext = await enrichLeadContext(lead._id);
            const contextPack = await buildContextPack(lead._id);

            // Só reaproveita memória como "verdade" quando a conversa NÃO esfriou
            const allowMemoryCarryOver = memoryContext?.shouldGreet === false;

            // =========================
            // 2) INTELIGÊNCIA (LLM + INTENT)
            // =========================
            const llmAnalysis = await analyzeLeadMessage({
                text,
                lead,
                history: memoryContext?.conversationHistory || []
            }).catch(() => ({}));

            const intelligent = llmAnalysis?.extractedInfo || {};
            const intentResult = this.intentDetector.detect(message, memoryContext);

            const analysis = {
                ...llmAnalysis,
                flags: intentResult.flags,
                therapyArea: intentResult.therapy,
                intent: intentResult.type,
                confidence: intentResult.confidence || 0.5
            };
            analysis.extractedInfo = intelligent;

            // =========================
            // 3) INFERRIDOS (SEM "ADIVINHAR" EM CONVERSA FRIA)
            // =========================
            const inferredTherapy =
                analysis.therapyArea ||
                intelligent?.especialidade ||
                (allowMemoryCarryOver ? memoryContext?.therapyArea : null) ||
                null;

            if (!analysis.therapyArea && inferredTherapy) analysis.therapyArea = inferredTherapy;
            // Normaliza extractedInfo
            analysis.extractedInfo = analysis.extractedInfo || analysis.extracted || {};
            if (analysis.extractedInfo.idade && !analysis.extractedInfo.age) {
                analysis.extractedInfo.age = analysis.extractedInfo.idade;
            }
            if (analysis.extractedInfo.disponibilidade && !analysis.extractedInfo.preferredPeriod) {
                analysis.extractedInfo.preferredPeriod = analysis.extractedInfo.disponibilidade;
            }

            const inferredAge =
                intelligent?.idade ||
                intelligent?.idadeRange ||
                analysis.extractedInfo?.age ||
                (allowMemoryCarryOver ? memoryContext?.patientAge : null) ||
                null;

            const inferredPeriodRaw =
                intelligent?.disponibilidade ||
                analysis.extractedInfo?.preferredPeriod ||
                lead?.qualificationData?.extractedInfo?.disponibilidade ||  // ← ADICIONAR ISSO
                lead?.pendingPreferredPeriod ||  // ← E ISSO (fallback)
                (allowMemoryCarryOver ? memoryContext?.preferredTime : null) ||
                null;

            const inferredPeriod = normalizePeriod(inferredPeriodRaw);

            const isMeaningfulComplaint = (c) => {
                if (!c) return false;
                const n = String(c).toLowerCase();
                if (n.length < 4) return false;
                if (/(inform|saber|d[uú]vida|valor|pre[cç]o|geral)/i.test(n)) return false;
                return true;
            };

            const inferredComplaintRaw =
                intelligent?.queixa ||
                analysis.extractedInfo?.queixa ||
                analysis.extractedInfo?.sintomas ||
                analysis.extractedInfo?.motivoConsulta ||
                (allowMemoryCarryOver ? memoryContext?.primaryComplaint : null) ||
                null;

            const inferredComplaint = isMeaningfulComplaint(inferredComplaintRaw)
                ? inferredComplaintRaw
                : null;


            // =========================
            // 4) ESTRATÉGIA
            // =========================
            const predictedStage = nextStage(lead, analysis);
            const urgency = calculateUrgency(analysis, memoryContext);

            // =========================
            // 5) BOOKING (STATE > INTENT)
            // =========================
            const bookingContext = {};

            const normalizeSlots = (v) => {
                v = normalizeSentinel(v);
                if (!v) return null;

                // legacy: array de slots
                if (Array.isArray(v)) {
                    const [primary, ...rest] = v;
                    return { primary: primary || null, alternativesSamePeriod: rest, alternativesOtherPeriod: [] };
                }

                // formato atual: primary = objeto
                if (typeof v === 'object') {
                    const primary = v.primary && !Array.isArray(v.primary) ? v.primary : null;

                    // se vier array por algum motivo
                    if (!primary && Array.isArray(v.primary)) {
                        const [p, ...rest] = v.primary;
                        return { primary: p || null, alternativesSamePeriod: rest, alternativesOtherPeriod: [] };
                    }

                    return {
                        primary,
                        alternativesSamePeriod: Array.isArray(v.alternativesSamePeriod) ? v.alternativesSamePeriod : [],
                        alternativesOtherPeriod: Array.isArray(v.alternativesOtherPeriod) ? v.alternativesOtherPeriod : [],
                    };
                }

                return null;
            };

            // Slots pendentes
            const pendingSlots = normalizeSlots(memoryContext?.pendingSchedulingSlots);
            const hasPendingSlots = !!pendingSlots?.primary;
            if (hasPendingSlots) bookingContext.slots = pendingSlots;

            // Slot escolhido na memória
            const existingChosenSlotRaw = normalizeSentinel(memoryContext?.chosenSlot);
            const existingChosenSlot =
                existingChosenSlotRaw && typeof existingChosenSlotRaw === 'object' ? existingChosenSlotRaw : null;

            // ✅ espelha pro bookingContext (DecisionEngine enxerga)
            if (existingChosenSlot) bookingContext.chosenSlot = existingChosenSlot;

            // Flags de prontidão
            const hasTherapy = !!inferredTherapy;
            const hasComplaint = !!inferredComplaint;
            const hasAge = !!inferredAge;
            const hasPeriod = !!inferredPeriod;

            const readyForSlots = hasTherapy && hasComplaint && hasAge && hasPeriod;

            const isSmartLead =
                intelligent?.especialidade &&
                intelligent?.queixa &&
                (intelligent?.idade || intelligent?.idadeRange) &&
                intelligent?.disponibilidade;

            if (isSmartLead) {
                analysis.intent = 'scheduling';
            }


            // ✅ CAPTURA SOMENTE O QUE VEIO DESTA MENSAGEM (antes do espelhamento)
            const freshFromThisMessage = {
                age: intelligent?.idade,
                period: intelligent?.disponibilidade,
                therapy: intelligent?.especialidade || intentResult?.therapy,
                complaint: intelligent?.queixa
            };

            // ✅ AGORA sim espelha inferidos para os handlers
            analysis.extractedInfo = {
                ...analysis.extractedInfo,
                therapyArea: analysis.extractedInfo?.therapyArea || inferredTherapy || null,
                preferredPeriod: analysis.extractedInfo?.preferredPeriod || inferredPeriod || null,
                age: analysis.extractedInfo?.age || inferredAge || null,
                queixa: analysis.extractedInfo?.queixa || inferredComplaint || null
            };

            // ✅ justAnsweredBasic só com dados FRESCOS
            const justAnsweredBasic = !!(
                freshFromThisMessage.age ||
                freshFromThisMessage.period ||
                freshFromThisMessage.therapy ||
                freshFromThisMessage.complaint
            );

            if (analysis.intent !== 'price' && (justAnsweredBasic || hasPendingSlots || !!existingChosenSlot)) {
                analysis.intent = 'scheduling';
            }

            // Busca slots só quando está realmente pronto
            /* if (analysis.intent === 'scheduling' && readyForSlots && !hasPendingSlots && !existingChosenSlot) {
                try {
                    const slots = await findAvailableSlots({
                        therapyArea: inferredTherapy,
                        preferredPeriod: inferredPeriod,
                        maxOptions: 2,
                        daysAhead: 30
                    });

                    if (slots?.primary) {
                        await Leads.findByIdAndUpdate(lead._id, {
                            $set: {
                                pendingSchedulingSlots: {
                                    primary: slots.primary,
                                    alternativesSamePeriod: slots.alternativesSamePeriod || [],
                                    alternativesOtherPeriod: slots.alternativesOtherPeriod || [],
                                    generatedAt: new Date()
                                }
                            }
                        });

                        bookingContext.slots = {
                            primary: slots.primary,
                            alternativesSamePeriod: slots.alternativesSamePeriod || [],
                            alternativesOtherPeriod: slots.alternativesOtherPeriod || []
                        };
                    }
                } catch (err) {
                    this.logger.error('Erro ao buscar slots', err);
                }
            } */

            // Escolha do slot (A/B/1/2...) com strict=true
            if (analysis.intent === 'scheduling' && bookingContext?.slots) {
                const chosenSlot = pickSlotFromUserReply(text, bookingContext.slots, { strict: true });

                if (chosenSlot) {
                    const validation = await validateSlotStillAvailable(chosenSlot, {
                        therapyArea: inferredTherapy,
                        preferredPeriod: inferredPeriod
                    });

                    if (!validation?.isValid) {
                        bookingContext.slotGone = true;
                        bookingContext.alternatives = validation?.freshSlots || null;

                        if (validation?.freshSlots) {
                            await Leads.findByIdAndUpdate(lead._id, {
                                $set: { pendingSchedulingSlots: validation.freshSlots }
                            });
                            bookingContext.slots = normalizeSlots(validation.freshSlots) || validation.freshSlots;
                        }
                    } else {
                        bookingContext.chosenSlot = chosenSlot;

                        await Leads.findByIdAndUpdate(lead._id, {
                            $set: { pendingChosenSlot: chosenSlot },
                            $unset: { pendingSchedulingSlots: "" }
                        });
                    }
                }
            }

            // =========================
            // 6) MISSING (SEMÂNTICA CORRETA)
            // =========================
            const hasSlotsToShow = !!bookingContext?.slots?.primary;
            const hasChosenSlotNow = !!(bookingContext?.chosenSlot || existingChosenSlot);

            const missing = {
                needsTherapy: !hasTherapy,

                // ✅ queixa imediatamente após terapia
                needsComplaint: hasTherapy && !hasComplaint,

                // ✅ idade depois da queixa
                needsAge: hasTherapy && hasComplaint && !hasAge,

                // ✅ período depois da idade
                needsPeriod: hasTherapy && hasComplaint && hasAge && !hasPeriod,

                // ✅ slots só depois de tudo acima
                needsSlot: readyForSlots && !hasSlotsToShow && !hasChosenSlotNow,

                // ✅ nome só depois de escolher slot
                needsName: hasChosenSlotNow && !memoryContext?.leadName && !analysis.extractedInfo?.nome
            };

            if (hasTherapy && missing.needsComplaint) {
                analysis.intent = 'scheduling';
            }

            // Se tem slots para mostrar (ou slot escolhido), força intent scheduling
            if (analysis.intent !== 'price' && (hasSlotsToShow || hasChosenSlotNow)) {
                analysis.intent = 'scheduling';
            }

            // Se temos dados suficientes mas não temos slots buscados ainda, 
            // FORÇA o intent para scheduling e busca slots
            if (readyForSlots && !hasPendingSlots && !existingChosenSlot) {
                analysis.intent = 'scheduling';

                // Busca slots imediatamente
                try {
                    const slots = await findAvailableSlots({
                        therapyArea: inferredTherapy,
                        preferredPeriod: inferredPeriod || lead?.qualificationData?.extractedInfo?.disponibilidade,
                        maxOptions: 2,
                        daysAhead: 30
                    });

                    if (slots?.primary) {
                        await Leads.findByIdAndUpdate(lead._id, {
                            $set: {
                                pendingSchedulingSlots: {
                                    primary: slots.primary,
                                    alternativesSamePeriod: slots.alternativesSamePeriod || [],
                                    alternativesOtherPeriod: slots.alternativesOtherPeriod || [],
                                    generatedAt: new Date()
                                }
                            }
                        });
                        bookingContext.slots = slots;
                    } else {
                        // 🚨 CRÍTICO: Se não achou slots, não pode oferecer horário!
                        bookingContext.noSlotsAvailable = true;
                    }
                } catch (err) {
                    this.logger.error('Erro ao buscar slots', err);
                    bookingContext.noSlotsAvailable = true;
                }
            }

            // 🚨 SE NÃO ACHOU SLOTS, NÃO CHAMA HANDLER/// apenas marca o contexto e deixa o handler resolver
            if (bookingContext.noSlotsAvailable) {
                bookingContext.flow = 'no_slots';
            }

            // =========================
            // 7) REGRAS CLÍNICAS
            // =========================
            const clinicalRules = clinicalRulesEngine({ memoryContext, analysis });

            if (bookingContext?.noSlotsAvailable || bookingContext?.flow === 'no_slots') {
                console.log('🛑 [ORCHESTRATOR] Forçando BookingHandler por falta de slots');

                const handler = this.normalizeHandler(handlers.bookingHandler);

                const decisionContext = {
                    message,
                    lead,
                    memory,
                    missing,
                    booking: bookingContext,
                    analysis
                };

                const reply = await handler.execute({ decisionContext, services });

                return reply;
            }


            // =========================
            // 8) DECISION ENGINE
            // =========================
            const decision = await decisionEngine({
                analysis,
                missing,
                urgency,
                bookingContext,
                clinicalRules
            });

            this.logger.info('DECISION_ENGINE', {
                intent: analysis.intent,
                handler: decision.handler,
                action: decision.action,
                reason: decision.reason,
                missing
            });

            // =========================
            // 9) EXECUTA HANDLER
            // =========================
            const rawHandler = handlers[decision.handler];
            const handler = this.normalizeHandler(rawHandler) || handlers.fallbackHandler;

            const decisionContext = {
                message,
                lead,
                memory: memoryContext,
                missing,
                booking: bookingContext,
                analysis
            };

            let result = await handler.execute({ decisionContext, services });
            // =========================
            // 9.5) SE HANDLER PEDIU GERAÇÃO VIA IA
            // =========================
            if (result?.needsAIGeneration && result?.promptContext) {
                try {
                    const aiText = await generateHandlerResponse({
                        promptContext: result.promptContext,
                        systemPrompt: contextPack?.systemPrompt,
                        lead,
                        memory: memoryContext
                    });

                    if (aiText) {
                        result = { ...result, text: aiText };
                    } else {
                        result = { ...result, text: result.fallbackText || 'Como posso te ajudar? 💚' };
                    }
                } catch (err) {
                    this.logger.error('Erro na geração IA do handler', err);
                    result = { ...result, text: result.fallbackText || 'Como posso te ajudar? 💚' };
                }
            }

            // =========================
            // 10) PERSISTÊNCIA DOS EXTRAÍDOS
            // =========================
            const set = {};

            if (inferredTherapy) set.therapyArea = inferredTherapy;
            if (inferredAge) set["patientInfo.age"] = inferredAge;
            if (inferredPeriod) set.pendingPreferredPeriod = inferredPeriod;
            if (inferredComplaint) set.primaryComplaint = inferredComplaint;

            // Espelha no qualificationData
            if (inferredTherapy) set["qualificationData.extractedInfo.therapyArea"] = inferredTherapy;
            if (inferredAge) set["qualificationData.extractedInfo.idade"] = inferredAge;
            if (inferredPeriod) set["qualificationData.extractedInfo.disponibilidade"] = inferredPeriod;
            if (inferredComplaint) set["qualificationData.extractedInfo.queixa"] = inferredComplaint;

            if (Object.keys(set).length) {
                await Leads.findByIdAndUpdate(lead._id, { $set: set });
            }

            // 🧠 GERAR RESUMO SE NECESSÁRIO
            try {
                const totalMessages = memoryContext?.conversationHistory?.length || 0;

                if (needsNewSummary(lead, totalMessages, [])) {
                    const messagesForSummary = memoryContext?.conversationHistory?.slice(-30) || [];
                    const summary = await generateConversationSummary(messagesForSummary);

                    if (summary) {
                        await Leads.findByIdAndUpdate(lead._id, {
                            $set: {
                                conversationSummary: summary,
                                summaryGeneratedAt: new Date(),
                                summaryCoversUntilMessage: totalMessages
                            }
                        });
                        console.log('✅ [RESUMO] Salvo no lead com sucesso');
                    }
                }
            } catch (e) {
                console.error('⚠️ [RESUMO] Erro ao gerar/salvar:', e.message);
            }

            // =========================
            // 11) APRENDIZADO (ÚNICO PONTO)
            // =========================
            if (result?.extractedInfo && Object.keys(result.extractedInfo).length > 0) {
                await ContextMemory.update(lead._id, result.extractedInfo);
            }

            // =========================
            // 12) RETORNO
            // =========================
            return {
                command: 'SEND_MESSAGE',
                payload: {
                    text: result?.text || 'Posso te ajudar com mais alguma coisa? 💚'
                }
            };

        } catch (error) {
            this.logger.error('Erro no WhatsAppOrchestrator', error);
            return {
                command: 'SEND_MESSAGE',
                payload: {
                    text: 'Tive um problema técnico aqui 😔 Pode tentar novamente?'
                },
                meta: { error: true }
            };
        }
    }
}

export default WhatsAppOrchestrator;
