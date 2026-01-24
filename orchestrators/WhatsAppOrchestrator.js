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
            }).catch(() => null);


            const intentResult = this.intentDetector.detect(message, memoryContext);

            const analysis = {
                ...llmAnalysis,
                flags: intentResult.flags,
                therapyArea: intentResult.therapy,
                intent: intentResult.type,
                confidence: intentResult.confidence || 0.5
            };

            // =========================
            // 3️⃣ ESTRATÉGIA
            // =========================
            const predictedStage = nextStage(lead, analysis);
            const urgency = calculateUrgency(analysis, memoryContext);

            // 4️⃣ MISSING INFO
            // =========================
            const missing = {
                needsName: !memoryContext?.name,
                needsAge: !memoryContext?.patientAge && !analysis?.extractedInfo?.age,
                needsTherapy: !memoryContext?.therapyArea && !analysis?.therapyArea,
                needsPeriod: !memoryContext?.preferredTime,
                needsSlot: !memoryContext?.chosenSlot
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

            // =========================
            // 🔟 APRENDIZADO
            // =========================
            if (result?.extractedInfo) {
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
