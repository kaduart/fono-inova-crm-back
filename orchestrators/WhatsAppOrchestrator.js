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
            const normalizedText = (text || '').trim().toLowerCase();

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

            const intentResult = this.intentDetector.detect(message, memoryContext);

            const analysis = {
                ...llmAnalysis,
                flags: intentResult.flags,
                therapyArea: intentResult.therapy,
                intent: intentResult.type,
                confidence: intentResult.confidence || 0.5
            };

            // Normaliza extractedInfo
            analysis.extractedInfo = analysis.extractedInfo || analysis.extracted || {};
            if (analysis.extractedInfo.idade && !analysis.extractedInfo.age) {
                analysis.extractedInfo.age = analysis.extractedInfo.idade;
            }
            if (analysis.extractedInfo.disponibilidade && !analysis.extractedInfo.preferredPeriod) {
                analysis.extractedInfo.preferredPeriod = analysis.extractedInfo.disponibilidade;
            }

            // =========================
            // 3) INFERRIDOS (SEM "ADIVINHAR" EM CONVERSA FRIA)
            // =========================
            const inferredTherapy =
                analysis.therapyArea ||
                (allowMemoryCarryOver ? memoryContext?.therapyArea : null) ||
                null;

            if (!analysis.therapyArea && inferredTherapy) analysis.therapyArea = inferredTherapy;

            const inferredAge =
                analysis.extractedInfo?.age ||
                (allowMemoryCarryOver ? memoryContext?.patientAge : null) ||
                null;

            const inferredPeriod =
                analysis.extractedInfo?.preferredPeriod ||
                (allowMemoryCarryOver ? memoryContext?.preferredTime : null) ||
                null;

            const inferredComplaint =
                analysis.extractedInfo?.queixa ||
                analysis.extractedInfo?.sintomas ||
                analysis.extractedInfo?.motivoConsulta ||
                (allowMemoryCarryOver ? memoryContext?.primaryComplaint : null) ||
                null;

            // =========================
            // 4) ESTRATÉGIA
            // =========================
            const predictedStage = nextStage(lead, analysis);
            const urgency = calculateUrgency(analysis, memoryContext);

            // =========================
            // 5) BOOKING (STATE > INTENT)
            // =========================
            const bookingContext = {};

            const pendingSlots = memoryContext?.pendingSchedulingSlots || null;


            const hasPendingSlots = !!pendingSlots?.primary?.length;
            if (hasPendingSlots) bookingContext.slots = pendingSlots;

            const existingChosenSlot = memoryContext?.chosenSlot || null;

            const hasBasicProfile = !!(inferredTherapy && inferredAge && inferredPeriod);
            const hasCompleteProfile = !!(hasBasicProfile && inferredComplaint);

            // Se acabou de responder dado básico, avançamos o estado para scheduling
            const justAnsweredBasic =
                !!(
                    analysis.extractedInfo?.age ||
                    analysis.extractedInfo?.preferredPeriod ||
                    analysis.therapyArea
                );

            if ((analysis.intent !== 'price') && (hasBasicProfile && (justAnsweredBasic || hasPendingSlots || existingChosenSlot))) {
                analysis.intent = 'scheduling';
            }

            // Busca slots só quando tem perfil completo + queixa
            if (analysis.intent === 'scheduling' && hasCompleteProfile && !hasPendingSlots && !existingChosenSlot) {
                try {
                    const slots = await findAvailableSlots({
                        therapyArea: inferredTherapy,
                        preferredPeriod: inferredPeriod,
                        maxOptions: 2,
                        daysAhead: 30
                    });

                    if (slots?.primary?.length) {
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
            }

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
                            bookingContext.slots = validation.freshSlots;
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
            const hasSlotsToShow = !!bookingContext?.slots?.primary?.length;
            const hasChosenSlotNow = !!(bookingContext?.chosenSlot || existingChosenSlot);

            const missing = {
                needsTherapy: !inferredTherapy,
                needsAge: !inferredAge,
                needsPeriod: !inferredPeriod,


                // Queixa só vira obrigatória quando já tem o básico
                needsComplaint: hasBasicProfile && !inferredComplaint,

                // Só precisa slot quando já tem queixa e ainda não tem slots nem slot escolhido
                needsSlot: hasCompleteProfile && !hasSlotsToShow && !hasChosenSlotNow,

                // Nome só depois de slot escolhido
                needsName: hasChosenSlotNow && !memoryContext?.leadName && !analysis.extractedInfo?.nome
            };

            if (hasBasicProfile && missing.needsComplaint) {
                analysis.intent = 'scheduling';
            }

            // Se tem slots para mostrar (ou slot escolhido), força intent scheduling
            if (analysis.intent !== 'price' && (hasSlotsToShow || hasChosenSlotNow)) {
                analysis.intent = 'scheduling';
            }

            // =========================
            // 7) REGRAS CLÍNICAS
            // =========================
            const clinicalRules = clinicalRulesEngine({ memoryContext, analysis });

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
            const decisionContext = {
                message: { text, raw: message },
                lead,
                memory: memoryContext,
                analysis,
                strategy: { predictedStage, urgency },
                missing,
                clinicalRules,
                booking: bookingContext,
                decision,
                contextPack
            };

            const rawHandler = handlers[decision.handler];
            const handler = this.normalizeHandler(rawHandler) || handlers.fallbackHandler;

            const result = await handler.execute({ decisionContext, services });

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
