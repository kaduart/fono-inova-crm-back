import Logger from '../services/utils/Logger.js';

// ✅ INFRAESTRUTURA EXISTENTE (do usuário)
import * as ContextMemory from '../services/intelligence/contextMemory.js';
import { buildContextPack } from '../services/intelligence/ContextPack.js';
import enrichLeadContext from '../services/leadContext.js';
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

// ✅ HANDLERS EXISTENTES
import * as handlers from '../handlers/index.js';
import Leads from '../models/Leads.js';
import { generateHandlerResponse } from '../services/aiAmandaService.js';
import generateConversationSummary, { needsNewSummary } from '../services/conversationSummary.js';

// ✅ DETECTOR EXISTENTE
import IntentDetector from '../detectors/IntentDetector.js';

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
            // 1️⃣ CONTEXTO (USANDO SEUS SERVIÇOS)
            // =========================
            const memoryContext = await enrichLeadContext(lead._id);
            const contextPack = await buildContextPack(lead._id);
            
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
            const inferred = this.extractInferredData({
                text,
                flags,
                detectedTherapies,
                intelligent,
                lead,
                memoryContext
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
            const decision = await decisionEngine({
                analysis,
                missing,
                urgency,
                bookingContext,
                clinicalRules
            });

            this.logger.info('DECISION', {
                handler: decision.handler,
                action: decision.action,
                reason: decision.reason,
                preserveState: decision.preserveBookingState
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
                flags
            };

            let result = await handler.execute({ decisionContext, services });

            // =========================
            // 🔟 GERA RESPOSTA IA SE NECESSÁRIO
            // =========================
            if (result?.needsAIGeneration && result?.promptContext) {
                try {
                    const aiText = await generateHandlerResponse({
                        promptContext: result.promptContext,
                        systemPrompt: contextPack?.systemPrompt,
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
            await this.persistData({
                lead,
                inferred,
                result,
                memoryContext
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
                    text: 'Desculpe, tive um problema técnico aqui 😔 Pode tentar novamente?'
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

    extractInferredData({ text, flags, detectedTherapies, intelligent, lead, memoryContext }) {
        const textLower = text.toLowerCase();
        const textNormalized = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

        // TERAPIA (cascata)
        let therapy = null;
        if (detectedTherapies.length > 0) {
            therapy = detectedTherapies[0].name;
        } else if (intelligent?.especialidade) {
            therapy = intelligent.especialidade;
        } else if (lead?.therapyArea) {
            therapy = lead.therapyArea;
        } else if (memoryContext?.therapyArea) {
            therapy = memoryContext.therapyArea;
        }

        // IDADE
        let age = intelligent?.idade || intelligent?.age || lead?.patientInfo?.age;
        if (typeof age === 'string') age = parseInt(age, 10);
        if (isNaN(age)) age = null;

        // PERÍODO
        let period = intelligent?.disponibilidade || intelligent?.preferredPeriod;
        if (!period) {
            if (textNormalized.includes("manh")) period = 'manha';
            else if (textNormalized.includes("tard")) period = 'tarde';
            else if (textNormalized.includes("noit")) period = 'noite';
        }
        period = normalizePeriod(period);

        // QUEIXA
        let complaint = intelligent?.queixa || lead?.primaryComplaint;
        
        // Data preferida
        const preferredDate = extractPreferredDateFromText(text);

        return {
            therapy,
            age,
            period,
            complaint,
            preferredDate,
            detectedTherapies: detectedTherapies.map(t => t.id)
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
            needsComplaint: !inferred.complaint && !flags.asksPrice, // Não exige queixa se só quer preço
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

    async persistData({ lead, inferred, result, memoryContext }) {
        const set = {};
        const unset = {};

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
            await Leads.findByIdAndUpdate(lead._id, { $set: set });
        }

        // Atualiza contexto
        if (result?.extractedInfo && Object.keys(result.extractedInfo).length > 0) {
            await ContextMemory.update(lead._id, result.extractedInfo);
        }

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
}

export default WhatsAppOrchestrator;
