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
import { detectTopicShift } from '../helpers/flowStateHelper.js';
import Leads from '../models/Leads.js';
import { generateHandlerResponse } from '../services/aiAmandaService.js';
import generateConversationSummary, { needsNewSummary } from '../services/conversationSummary.js';
import { decisionEngine } from '../services/intelligence/DecisionEngine.js';
import { normalizePeriod } from '../utils/normalizePeriod.js';

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
                // Bloqueia strings genéricas
                if (['não', 'nao', 'n/a', 'no', 'sim', 'yes', 'true', 'false'].includes(s)) {
                    return null;
                }
            }
            // Se não for objeto válido, retorna null
            if (v && typeof v !== 'object') return null;
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
            }).catch((err) => {
                console.error('❌ [LLM ANALYSIS ERROR]', err.message);
                return {};
            });

            const intelligent = llmAnalysis?.extractedInfo || {};
            const intentResult = this.intentDetector.detect(message, memoryContext);
            console.log('🧠 [LLM EXTRACTION DEBUG]', {
                text: text.substring(0, 60),
                queixa: intelligent?.queixa,
                especialidade: intelligent?.especialidade,
                fullExtracted: JSON.stringify(intelligent)
            });
            const isSideIntent = (i) => ['price', 'therapy_info', 'general_info'].includes(i);

            if (intentResult.type === 'product_inquiry' || intentResult.flags?.asksPrice) {
                intentResult.type = 'price';
            }

            const analysis = {
                ...llmAnalysis,
                flags: intentResult.flags,
                therapyArea: intentResult.therapy,
                intent: intentResult.type,
                confidence: intentResult.confidence || 0.5
            };
            analysis.extractedInfo = intelligent;

            // 🆕 GUARDAR INTENT ORIGINAL ANTES DAS FORÇAGENS
            const originalIntent = analysis.intent;

            // =========================
            // 3) INFERRIDOS (SEM "ADIVINHAR" EM CONVERSA FRIA)
            // =========================
            // 🧠 DETECÇÃO RÁPIDA DE TERAPIA (fallback quando LLM não pegou)
            // 🧠 Normalização para diferentes propósitos
            const textLower = text.toLowerCase();
            const normalizeText = (t) => String(t).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
            const textNormalized = normalizeText(text);

            let quickPeriod = null;
            if (textNormalized.includes("manh")) quickPeriod = 'manha';
            else if (textNormalized.includes("tard")) quickPeriod = 'tarde';
            else if (textNormalized.includes("noit")) quickPeriod = 'noite';

            console.log('🧪 [QUICK PERIOD TEST]', {
                original: text.substring(0, 50),
                normalized: textNormalized.substring(0, 50),
                quickPeriod
            });

            let quickTherapy = null;
            if (textLower.match(/\bpsico(log|l[oó]gica)?\b/)) quickTherapy = 'psicologia';
            else if (textLower.match(/\bfono\b/)) quickTherapy = 'fonoaudiologia';
            else if (textLower.match(/\bto\b|\bterapia ocupacional\b/)) quickTherapy = 'terapia ocupacional';
            else if (textLower.match(/\bfisio\b/)) quickTherapy = 'fisioterapia';

            // Agora usa o quickTherapy como fallback
            const inferredTherapy =
                quickTherapy ||
                analysis.therapyArea ||
                intelligent?.especialidade ||
                lead?.therapyArea ||  // ✅ ADICIONAR
                lead?.qualificationData?.extractedInfo?.therapyArea ||  // ✅ ADICIONAR
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

            const inferredAgeRaw =
                intelligent?.idade ||
                analysis.extractedInfo?.age ||
                lead?.patientInfo?.age ||
                lead?.qualificationData?.extractedInfo?.idade ||
                (allowMemoryCarryOver ? memoryContext?.patientAge : null) ||
                null;

            // ✅ Só aceita se for número válido
            const inferredAge = (typeof inferredAgeRaw === 'number' && !isNaN(inferredAgeRaw))
                ? inferredAgeRaw
                : null;

            // ✅ idadeRange separado (para lógica de perfil, não para salvar)
            const inferredAgeRange =
                intelligent?.idadeRange ||
                lead?.qualificationData?.extractedInfo?.idadeRange ||
                null;

            const inferredPeriodRaw =
                quickPeriod ||  // <-- ADICIONAR PRIMEIRO
                intelligent?.disponibilidade ||
                analysis.extractedInfo?.preferredPeriod ||
                lead?.qualificationData?.extractedInfo?.disponibilidade ||
                lead?.pendingPreferredPeriod ||
                (allowMemoryCarryOver ? memoryContext?.preferredTime : null) ||
                null;

            const inferredPeriod = normalizePeriod(inferredPeriodRaw);

            console.log('🕐 [PERIOD CAPTURED]', {
                text: text.substring(0, 100),
                textLower: textLower.substring(0, 100),
                quickPeriod,
                intelligent_disponibilidade: intelligent?.disponibilidade,
                inferredPeriodRaw,
                inferredPeriod,
                hasPeriod: !!inferredPeriod
            });

            const isMeaningfulComplaint = (c) => {
                if (!c) return false;
                const n = String(c).toLowerCase().trim();
                if (n.length < 4) return false;

                // Só bloqueia se for EXPLICITAMENTE sobre preço/info geral, não se for "saber sobre terapia"
                const pricePatterns = /\b(valor|pre[cç]o|custo|quanto custa|dinheiro|pix)\b/i;
                const genericOnly = /^(saber|informa[çc][aã]o|d[uú]vida|oi|ol[aá])$/i;

                // Se for só "saber" ou "informação" sem contexto, rejeita
                if (genericOnly.test(n)) return false;

                // Se for só sobre preço, rejeita como queixa clínica
                if (pricePatterns.test(n) && !/\b(filho|filha|meu|minha|crian[çc]a|comportamento|ansiedade|depress[ãa]o|tdah|autismo)\b/i.test(n)) {
                    return false;
                }

                return true;
            };

            const inferredComplaintRaw =
                intelligent?.queixa ||
                analysis.extractedInfo?.queixa ||
                analysis.extractedInfo?.sintomas ||
                analysis.extractedInfo?.motivoConsulta ||
                lead?.primaryComplaint ||  // ✅ ADICIONAR
                lead?.qualificationData?.extractedInfo?.queixa ||  // ✅ ADICIONAR
                (allowMemoryCarryOver ? memoryContext?.primaryComplaint : null) ||
                null;

            const inferredComplaint = isMeaningfulComplaint(inferredComplaintRaw)
                ? inferredComplaintRaw
                : null;

            // 🧠  Contexto familiar
            if (!inferredComplaint && text.toLowerCase().match(/\b(filho|filha|meu filho|minha filha)\b/)) {
                analysis.extractedInfo = {
                    ...analysis.extractedInfo,
                    parentesco: 'filho',
                    queixaContexto: 'consulta_pediatrica'
                };
            }

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
            // ADICIONAR VALIDAÇÃO: só aceita se for objeto válido com doctorId
            const existingChosenSlot = (existingChosenSlotRaw &&
                typeof existingChosenSlotRaw === 'object' &&
                existingChosenSlotRaw.doctorId &&  // <-- CRÍTICO
                existingChosenSlotRaw.date &&
                existingChosenSlotRaw.time) ? existingChosenSlotRaw : null;
            // 🛠️ CORREÇÃO: Copia slot do banco para o contexto se válido
            if (existingChosenSlot) {
                bookingContext.chosenSlot = existingChosenSlot;
                console.log('📦 [CONTEXT] Slot do banco carregado:', existingChosenSlot.doctorId);
            }

            // Também limpar o campo se vier string errada do banco
            if (existingChosenSlotRaw && typeof existingChosenSlotRaw === 'string') {
                // Limpa sujeira do banco
                await Leads.findByIdAndUpdate(lead._id, { $unset: { pendingChosenSlot: 1 } });
            }

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

            if (!isSideIntent(analysis.intent) && (justAnsweredBasic || hasPendingSlots || !!existingChosenSlot)) {
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
                // 🐛 DEBUG: Antes de tentar pegar o slot
                console.log('🎯 [SLOT CHOICE] Texto recebido:', text);
                console.log('🎯 [SLOT CHOICE] Slots disponíveis:', {
                    primary: bookingContext.slots.primary?.time,
                    alternatives: bookingContext.slots.alternativesSamePeriod?.length
                });

                const chosenSlot = pickSlotFromUserReply(text, bookingContext.slots, { strict: true });

                // 🐛 DEBUG: Depois de tentar pegar
                console.log('🎯 [SLOT CHOICE] Resultado:', chosenSlot ? {
                    doctorId: chosenSlot.doctorId,
                    date: chosenSlot.date,
                    time: chosenSlot.time
                } : 'NULL');

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

                        // 🐛 DEBUG: Antes de salvar no banco
                        console.log('💾 [SLOT SAVE] Salvando slot:', {
                            doctorId: chosenSlot.doctorId,
                            date: chosenSlot.date,
                            time: chosenSlot.time,
                            doctorName: chosenSlot.doctorName
                        });

                        await Leads.findByIdAndUpdate(lead._id, {
                            $set: { pendingChosenSlot: chosenSlot },
                            $unset: { pendingSchedulingSlots: "" }
                        });

                        // 🐛 DEBUG: Confirmação
                        console.log('✅ [SLOT SAVED] Slot salvo no lead ID:', lead._id);
                    }
                }
            }

            const patientNameFromLead = lead?.patientInfo?.name || lead?.autoBookingContext?.patientName;
            // =========================
            // 6) MISSING (SEMÂNTICA CORRETA)
            // =========================
            const hasSlotsToShow = !!bookingContext?.slots?.primary;
            const hasChosenSlotNow = !!(
                bookingContext?.chosenSlot?.doctorId ||
                existingChosenSlot?.doctorId
            );

            // Usando o helper - mantém mesma lógica mas com currentAwaiting automático
            const missing = {
                needsTherapy: !hasTherapy,
                needsComplaint: hasTherapy && !hasComplaint,
                needsAge: hasTherapy && hasComplaint && !hasAge,
                needsPeriod: hasTherapy && hasComplaint && hasAge && !hasPeriod,
                needsSlot: readyForSlots && !hasSlotsToShow && !hasChosenSlotNow,
                needsSlotSelection: hasSlotsToShow && !hasChosenSlotNow,
                needsName: hasChosenSlotNow && !memoryContext?.patientName && !analysis.extractedInfo?.patientName && !patientNameFromLead,

                // 🆕 ADICIONAR: Para os helpers e DecisionEngine saberem o que perguntar na retomada
                currentAwaiting: !hasTherapy ? 'therapy' :
                    !hasComplaint ? 'complaint' :
                        !hasAge ? 'age' :
                            !hasPeriod ? 'period' :
                                !hasChosenSlotNow && hasSlotsToShow ? 'slot_selection' :
                                    !patientNameFromLead && hasChosenSlotNow ? 'patient_name' : null
            };

            if (!isSideIntent(analysis.intent) && hasTherapy && missing.needsComplaint) {
                analysis.intent = 'scheduling';
            }


            // Se tem slots para mostrar (ou slot escolhido), força intent schedulingÆÆÆ
            if (!isSideIntent(analysis.intent) && (hasSlotsToShow || hasChosenSlotNow)) {
                analysis.intent = 'scheduling';
            }

            // Se temos dados suficientes mas não temos slots buscados ainda, 
            // FORÇA o intent para scheduling e busca slots
            if (!isSideIntent(analysis.intent) && readyForSlots && !hasPendingSlots && !existingChosenSlot) {
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
                    memory: memoryContext,
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

            // =========================
            // 9.5) EXECUTA HANDLER + TRATA INTERRUPIÇÃO / GERAÇÃO IA
            // =========================
            let result;

            // Usando helper para detectar interrupção de forma inteligente
            const topicShift = detectTopicShift({
                currentIntent: originalIntent,
                messageText: text,
                lead,
                bookingContext,
                missing
            });

            if ((decision.preserveBookingState || topicShift.isInterruption) && isSideIntent(originalIntent)) {
                const sideHandler = handlers[
                    originalIntent === 'price' ? 'productHandler' :
                        originalIntent === 'therapy_info' ? 'therapyHandler' :
                            'fallbackHandler'
                ];
                result = await sideHandler.execute({ decisionContext, services });

                // Marca que precisa de retomada após responder a interrupção
                result.needsResumption = true;
                result.nextField = missing.currentAwaiting; // 🆕 Usa direto do missing
            } else {
                // Fluxo normal
                result = await handler.execute({ decisionContext, services });
            }

            // Se precisa de geração IA, gera o texto base
            if (result?.needsAIGeneration && result?.promptContext) {
                try {
                    const aiText = await generateHandlerResponse({
                        promptContext: result.promptContext,
                        systemPrompt: contextPack?.systemPrompt,
                        lead,
                        memory: memoryContext
                    });

                    if (aiText) {
                        result.text = aiText;
                    } else {
                        result.text = result.fallbackText || 'Como posso te ajudar? 💚';
                    }
                } catch (err) {
                    this.logger.error('Erro na geração IA do handler', err);
                    result.text = result.fallbackText || 'Como posso te ajudar? 💚';
                }
            }

            // =========================
            // RETOMADA INTELIGENTE (FUNCIONA EM QUALQUER ESTÁGIO)
            // =========================
            const shouldResume = (decision.preserveBookingState && decision.pendingField) ||
                (result.needsResumption && result.nextField);

            if (shouldResume) {
                const fieldToResume = decision.pendingField || result.nextField;

                const retomadaMap = {
                    'therapy': '\n\nPara te ajudar melhor, qual é a especialidade que procura? 💚',
                    'complaint': '\n\nVoltando ao agendamento: qual é a situação principal que gostaria de tratar? 💚',
                    'age': '\n\nPara buscar os horários certinhos, qual a idade do paciente? 💚',
                    'period': '\n\nPrefere manhã ou tarde para o atendimento? ☀️🌙',
                    'slot_selection': '\n\nQuando quiser continuar, é só escolher A, B ou C 💚',
                    'patient_name': '\n\nSó falta o nome completo para confirmarmos! 💚'
                };

                const retomadaText = retomadaMap[fieldToResume] || '\n\nQuer continuar o agendamento? 💚';

                // Adiciona retomada (handler já removeu CTA genérico se era interrupção)
                result.text += retomadaText;
            }

            // =========================
            // 10) PERSISTÊNCIA DOS EXTRAÍDOS
            // =========================
            if (result?.skipValidation) {
                console.log('⏸️ [PERSISTENCE] Pulando persistência - aguardando retomada do fluxo');
            } else {
                const set = {};

                // 🔍 DEBUG: Mostrar valores no momento da construção
                console.log('🔍 [PRE-SET DEBUG]', {
                    inferredTherapy,
                    inferredComplaint,
                    inferredAge,
                    inferredPeriod
                });

                if (inferredTherapy) set.therapyArea = inferredTherapy;
                if (inferredAge && typeof inferredAge === 'number') {
                    set["patientInfo.age"] = inferredAge;
                }
                // ✅ Salva idadeRange separado se existir
                if (inferredAgeRange) {
                    set["qualificationData.extractedInfo.idadeRange"] = inferredAgeRange;
                }
                if (inferredComplaint) set.primaryComplaint = inferredComplaint;

                // ✅ ADICIONAR: Se handler retornou nome, salva
                if (result?.extractedInfo?.patientName) {
                    set["patientInfo.name"] = result.extractedInfo.patientName;
                    set["autoBookingContext.patientName"] = result.extractedInfo.patientName;
                }

                // ✅ MOVER PRA CÁ: Espelha no qualificationData ANTES do save
                if (inferredTherapy) set["qualificationData.extractedInfo.therapyArea"] = inferredTherapy;
                if (inferredAge) set["qualificationData.extractedInfo.idade"] = inferredAge;
                if (inferredPeriod) set["qualificationData.extractedInfo.disponibilidade"] = inferredPeriod;
                if (inferredComplaint) set["qualificationData.extractedInfo.queixa"] = inferredComplaint;

                // 🔍 DEBUG: Mostrar set completo ANTES do save
                console.log('💾 [PRE-SAVE SET]', {
                    setKeys: Object.keys(set),
                    fullSet: set
                });

                // 🔴 AGORA SIM O SAVE INCLUI TUDO
                if (Object.keys(set).length) {
                    await Leads.findByIdAndUpdate(lead._id, { $set: set });
                }

                console.log('💾 [POS SAVE]', {
                    inferredPeriod,
                    willSave: !!inferredPeriod,
                    setKeys: Object.keys(set),
                    fullSet: set
                });

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
