import Logger from '../services/utils/Logger.js';

// Memory & Context
import * as ContextMemory from '../services/intelligence/contextMemory.js';
import { buildContextPack } from '../services/intelligence/ContextPack.js';
import enrichLeadContext from '../services/leadContext.js';

// Intelligence
import { analyzeLeadMessage } from '../services/intelligence/leadIntelligence.js';
import { nextStage } from '../services/intelligence/stageEngine.js';

// Utils

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

            // =========================
            // 1️⃣ MEMÓRIA & CONTEXTO
            // =========================
            const memoryContext = await enrichLeadContext(lead._id);
            const contextPack = await buildContextPack(lead._id);

            // =========================
            // 2️⃣ INTELIGÊNCIA
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

            analysis.extractedInfo = analysis.extractedInfo || analysis.extracted || {};
            if (analysis.extractedInfo.idade && !analysis.extractedInfo.age) {
                analysis.extractedInfo.age = analysis.extractedInfo.idade;
            }
            if (analysis.extractedInfo.disponibilidade && !analysis.extractedInfo.preferredPeriod) {
                analysis.extractedInfo.preferredPeriod = analysis.extractedInfo.disponibilidade;
            }

            // ✅ Continuidade natural: se o lead respondeu "tarde", mantém a terapia anterior
            const inferredTherapy =
                analysis.therapyArea ||
                memoryContext?.therapyArea ||
                memoryContext?.mentionedTherapies?.[0] ||
                analysis.extractedInfo.therapyArea ||
                analysis.extractedInfo.areaTerapia ||
                null;

            if (!analysis.therapyArea && inferredTherapy) analysis.therapyArea = inferredTherapy;

            // =========================
            // 3️⃣ ESTRATÉGIA
            // =========================
            const predictedStage = nextStage(lead, analysis);
            const urgency = calculateUrgency(analysis, memoryContext);

            const inferredAge =
                memoryContext?.patientAge ||
                analysis.extractedInfo.age ||
                null;

            const inferredPeriod =
                memoryContext?.preferredTime ||
                analysis.extractedInfo.preferredPeriod ||
                null;

            const missing = {
                needsName: !memoryContext?.leadName,
                needsAge: !inferredAge,
                needsTherapy: !inferredTherapy,
                needsPeriod: !inferredPeriod,
                needsSlot: !memoryContext?.chosenSlot,
            };


            // =========================
            // 5️⃣ REGRAS CLÍNICAS
            // =========================
            const clinicalRules = clinicalRulesEngine({
                memoryContext,
                analysis
            });

            // =========================
            // 6️⃣ BOOKING INTELIGENTE
            // =========================
            let bookingContext = {};

            if (analysis.intent === 'scheduling' && memoryContext?.pendingSlots) {
                const chosenSlot = pickSlotFromUserReply(text, memoryContext.pendingSlots);

                if (chosenSlot) {
                    const stillAvailable = await validateSlotStillAvailable(chosenSlot);

                    if (!stillAvailable) {
                        const freshSlots = await findAvailableSlots({
                            therapy: memoryContext.therapyArea,
                            period: memoryContext.preferredTime
                        });

                        bookingContext = {
                            alternatives: freshSlots || []
                        };
                    } else {
                        bookingContext.chosenSlot = chosenSlot;
                    }
                }

            }

            // =========================
            // 7️⃣ DECISION ENGINE
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
                missing,
                urgency
            });


            // =========================
            // 8️⃣ DECISION CONTEXT
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

            // =========================
            // 9️⃣ EXECUTA HANDLER
            // =========================
            const rawHandler = handlers[decision.handler];
            const handler = this.normalizeHandler(rawHandler) || handlers.fallbackHandler;
            if (!rawHandler) {
                this.logger.warn('Handler não encontrado, usando fallback', {
                    decision
                });
            }

            const result = await handler.execute({
                decisionContext,
                services
            });

            const extracted = analysis.extractedInfo || {};

            const set = {};
            if (inferredTherapy) set.therapyArea = inferredTherapy;
            if (inferredAge) set["patientInfo.age"] = inferredAge;
            if (inferredPeriod) set.pendingPreferredPeriod = inferredPeriod;

            // espelha no qualificationData pra histórico (não quebra nada)
            if (inferredTherapy) set["qualificationData.extractedInfo.therapyArea"] = inferredTherapy;
            if (inferredAge) set["qualificationData.extractedInfo.idade"] = inferredAge;
            if (inferredPeriod) set["qualificationData.extractedInfo.disponibilidade"] = inferredPeriod;

            // autoBookingContext pode ser null no schema → setar objeto inteiro evita erro de dot-notation
            const currentAuto =
                lead.autoBookingContext && typeof lead.autoBookingContext === "object"
                    ? lead.autoBookingContext
                    : {};

            const auto = { ...currentAuto };
            let autoChanged = false;

            if (inferredTherapy) {
                auto.therapyArea = inferredTherapy;
                auto.mappedTherapyArea = inferredTherapy;
                autoChanged = true;
            }
            if (inferredPeriod) {
                auto.preferredPeriod = inferredPeriod;
                autoChanged = true;
            }
            if (autoChanged) {
                set.autoBookingContext = auto;
            }

            if (Object.keys(set).length) {
                await Leads.findByIdAndUpdate(lead._id, { $set: set });
            }


            // =========================
            // 🔟 APRENDIZADO (ÚNICO)
            // =========================
            if (result?.extractedInfo && Object.keys(result.extractedInfo).length > 0) {
                await ContextMemory.update(lead._id, result.extractedInfo);
            }

            // =========================
            // 11️⃣ RETORNO
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
