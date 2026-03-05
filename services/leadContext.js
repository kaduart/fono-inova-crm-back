// services/leadContext.js
// 🏆 FONTE ÚNICA DE VERDADE DO CONTEXTO
// Unificou: ContextPack.js + contextMemory.js + funcionalidades originais

import Appointment from '../models/Appointment.js';
import Lead from '../models/Leads.js';
import Message from '../models/Message.js';
// ❌ DEPRECATED: import ChatContext from '../models/ChatContext.js';
import { generateConversationSummary, needsNewSummary } from './conversationSummary.js';
import { determineMode } from './intelligence/ModeRouter.js';

/**
 * 🎯 FUNÇÃO PRINCIPAL: Enriquece contexto completo do lead
 * Substitui: ContextPack.buildContextPack() + funções originais
 */
export async function enrichLeadContext(leadId) {
    try {
        // ✅ Busca lead (não usa populate - contact é objeto embutido)
        const lead = await Lead.findById(leadId).lean();

        if (!lead) {
            return getDefaultContext();
        }

        // ✅ Busca TODAS as mensagens ordenadas
        const messages = await Message.find({
            lead: leadId,
            type: { $in: ['text', 'template', 'image', 'audio', 'video', 'document'] }
        })
            .sort({ timestamp: 1 })
            .lean();

        const totalMessages = messages.length;

        // ✅ Últimas 20 mensagens (para análise recente)
        const recentMessages = messages.slice(-20);
        const lastUserMessage = [...recentMessages].reverse().find(m => m.direction === 'inbound');
        const lastAmandaMessage = [...recentMessages].reverse().find(m => m.direction === 'outbound');

        // ✅ Busca agendamentos futuros
        const today = new Date().toISOString().split('T')[0];
        const appointments = lead.convertedToPatient
            ? await Appointment.find({
                patient: lead.convertedToPatient,
                date: { $gte: today }
            }).lean()
            : [];

        // ✅ Determina modo, tom e urgência (do ContextPack.js)
        const mode = determineMode({ lead, lastUserMessage, recentMessages });
        const toneMode = determineToneMode({ lead, lastUserMessage });
        const urgencyLevel = determineUrgencyLevel(lead);

        // 🧠 CONTEXTO INTELIGENTE
        let conversationHistory = [];
        let shouldGreet = true;
        let summaryContext = lead.conversationSummary || null;

        if (totalMessages === 0) {
            conversationHistory = [];
            shouldGreet = true;
        }
        else if (totalMessages <= 20) {
            // Conversa curta: manda tudo
            conversationHistory = messages
                .filter(msg => (msg.content || '').toString().trim().length > 0)
                .map(msg => ({
                    role: msg.direction === 'inbound' ? 'user' : 'assistant',
                    content: msg.content,
                    timestamp: msg.timestamp,
                    type: msg.type
                }));

            // Checa saudação
            const lastMsgTime = messages[messages.length - 1]?.timestamp;
            if (lastMsgTime) {
                const hoursSince = (Date.now() - new Date(lastMsgTime)) / (1000 * 60 * 60);
                shouldGreet = hoursSince > 24;
            }
        }
        else {
            // Conversa longa: resumo + últimas 20
            let leadDoc = await Lead.findById(leadId);

            if (needsNewSummary(lead, totalMessages, appointments)) {
                // Usa o resumo existente para esta resposta (não bloqueia o usuário)
                // e regenera em background para a próxima mensagem
                summaryContext = lead.conversationSummary;
                const oldMessages = messages.slice(0, -20);
                generateConversationSummary(oldMessages).then(summary => {
                    if (summary) {
                        leadDoc.updateOne({
                            conversationSummary: summary,
                            summaryGeneratedAt: new Date(),
                            summaryCoversUntilMessage: totalMessages - 20
                        }).catch(e => console.warn('[RESUMO] Erro ao salvar resumo bg:', e.message));
                    }
                }).catch(e => console.warn('[RESUMO] Erro ao gerar resumo bg:', e.message));
            } else {
                summaryContext = lead.conversationSummary;
            }

            const recentMsgs = messages.slice(-20);
            conversationHistory = recentMsgs
                .filter(msg => (msg.content || '').toString().trim().length > 0)
                .map(msg => ({
                    role: msg.direction === 'inbound' ? 'user' : 'assistant',
                    content: msg.content,
                    timestamp: msg.timestamp,
                    type: msg.type
                }));

            const lastMsgTime = recentMsgs[recentMsgs.length - 1]?.timestamp;
            if (lastMsgTime) {
                const hoursSince = (Date.now() - new Date(lastMsgTime)) / (1000 * 60 * 60);
                shouldGreet = hoursSince > 24;
            }
        }

        // ✅ Normalizações alinhadas ao schema
        const patientAge =
            lead.patientInfo?.age ??
            lead.patientAge ??
            lead.qualificationData?.extractedInfo?.age ??
            lead.qualificationData?.extractedInfo?.idade ??
            null;

        const ageGroup =
            lead.qualificationData?.extractedInfo?.idadeRange ??
            null;

        const preferredTime =
            lead.pendingPreferredPeriod ??
            lead.preferredTime ??
            lead.autoBookingContext?.preferredPeriod ??
            lead.qualificationData?.extractedInfo?.disponibilidade ??
            lead.qualificationData?.extractedInfo?.preferredPeriod ??
            null;

        const therapyArea =
            lead.therapyArea ??
            lead.mappedTherapyArea ??
            lead.qualificationData?.extractedInfo?.therapyArea ??
            lead.qualificationData?.extractedInfo?.mappedTherapyArea ??
            lead.autoBookingContext?.therapyArea ??
            lead.qualificationData?.extractedInfo?.areaTerapia ??
            null;
        
        const primaryComplaint =
            lead.primaryComplaint ??
            lead.qualificationData?.extractedInfo?.queixa ??
            lead.qualificationData?.extractedInfo?.sintomas ??
            lead.qualificationData?.extractedInfo?.motivoConsulta ??
            lead.qualificationData?.extractedInfo?.complaint ??
            null;

        // ✅ Padrões de comportamento
        const behaviorPatterns = detectBehaviorPatterns(messages);

        // ✅ Monta contexto final (UNIFICADO)
        const context = {
            // Dados básicos
            leadId: lead._id,
            name: lead.name || null,
            leadName: lead.name || lead.patientName || null,
            leadFirstName: lead.name ? lead.name.split(' ')[0] : null,

            phone: lead.contact?.phone || lead.phone || null,
            origin: lead.origin,

            // Status
            hasAppointments: appointments?.length > 0,
            isPatient: !!lead.convertedToPatient,
            conversionScore: lead.conversionScore || 0,
            status: lead.status,
            stage: determineLeadStage(lead, messages, appointments),

            // Modo, Tom e Urgência (novo do ContextPack)
            mode,
            toneMode,
            urgencyLevel,
            knownFacts: lead.knownFacts || {},
            lastAgreement: lead.lastAgreement || null,

            // Mensagens
            recentMessages,
            lastUserMessage,
            lastAmandaMessage,

            // Comportamento
            messageCount: totalMessages,
            lastInteraction: lead.lastInteractionAt,
            daysSinceLastContact: calculateDaysSince(lead.lastInteractionAt),
            behaviorPatterns,

            // Dados do paciente
            patientAge,
            ageGroup,
            preferredTime,
            primaryComplaint,
            complaint: primaryComplaint,

            // Slots / agendamento
            chosenSlot: lead.pendingChosenSlot || lead.autoBookingContext?.chosenSlot || null,
            pendingChosenSlot: lead.pendingChosenSlot || null,
            pendingSchedulingSlots: lead.pendingSchedulingSlots || null,
            pendingSlots: lead.pendingSchedulingSlots ?? lead.autoBookingContext?.pendingSchedulingSlots ?? lead.autoBookingContext?.lastOfferedSlots ?? null,

            autoBookingContext: lead.autoBookingContext || null,
            therapyArea,

            // Contexto inteligente
            conversationHistory,
            conversationSummary: summaryContext,
            shouldGreet,

            // Intenções
            mentionedTherapies: extractMentionedTherapies(messages),

            // 🆕 Emotional Markers (para acolhimento contextual)
            emotionalMarkers: extractEmotionalMarkers(messages, lead),

            // 🆕 Last Topics (para IA referenciar naturalmente)
            lastTopics: extractLastTopics(messages),

            // Flags úteis
            isFirstContact: totalMessages <= 1,
            isReturning: totalMessages > 3,
            needsUrgency: calculateDaysSince(lead.lastInteractionAt) > 7,

            futureAppointmentsCount: appointments?.length || 0,
            appointmentsInfo: appointments?.length > 0
                ? appointments.map(a => ({ date: a.date, time: a.time, type: a.type }))
                : null,

            appointmentWarning: appointments?.length === 0
                ? '⚠️ ATENÇÃO: Este lead NÃO possui agendamentos futuros. NÃO mencione consultas marcadas ou confirmadas.'
                : null,

            _debug: {
                rootTherapy: lead.therapyArea,
                autoBookingTherapy: lead.autoBookingContext?.therapyArea,
                qualificationTherapy: lead.qualificationData?.extractedInfo?.therapyArea,
                hasComplaint: !!primaryComplaint,
                hasSlots: !!(lead.pendingSchedulingSlots || lead.autoBookingContext?.pendingSchedulingSlots)
            }
        };

        return context;

    } catch (error) {
        console.error('Erro ao montar contexto do lead:', error);
        return getDefaultContext();
    }
}

/**
 * 📝 SALVA INFORMAÇÕES EXTRAÍDAS (do contextMemory.js)
 * Substitui: contextMemory.update()
 */
export { extractEmotionalMarkers, extractLastTopics };

export async function updateExtractedInfo(leadId, extractedInfo) {
    if (!extractedInfo || Object.keys(extractedInfo).length === 0) return null;

    try {
        const updateData = {
            lastExtractedInfo: extractedInfo,
            lastUpdatedAt: new Date()
        };

        console.log('[LeadContext] Salvando extractedInfo:', {
            leadId: leadId?.toString?.() || leadId,
            extractedInfo
        });

        const result = await ChatContext.findOneAndUpdate(
            { lead: leadId },
            { $set: updateData },
            { upsert: true, new: true }
        );

        console.log('[LeadContext] Salvo com sucesso:', {
            leadId: leadId?.toString?.() || leadId
        });

        return true;
    } catch (error) {
        console.error("❌ [LeadContext] Erro ao atualizar extractedInfo:", error);
        return null;
    }
}

/**
 * 🔄 Gera mensagem de Warm Recall (do ContextPack.js)
 * Substitui: ContextPack.generateWarmRecall()
 */
export function generateWarmRecall(context, lead) {
    const hoursSince = context?.lastInteraction
        ? (Date.now() - new Date(context.lastInteraction)) / (1000 * 60 * 60)
        : 48;

    const childName = lead?.childData?.name || lead?.knownFacts?.childName;
    const childAge = extractChildAge(lead);
    const parentName = lead?.name?.split(' ')[0] || "";
    const therapyType = lead?.therapyArea || lead?.knownFacts?.therapyType || "avaliação";

    const isDevelopmentalWindow = childAge !== null && childAge <= 6;

    if (hoursSince > 72) {
        return generate72hRecall({ parentName, childName, childAge, isDevelopmentalWindow, therapyType });
    } else if (hoursSince > 48) {
        return generate48hRecall({ parentName, childName, childAge, isDevelopmentalWindow, therapyType });
    } else {
        return generate24hRecall({ parentName, childName, isDevelopmentalWindow });
    }
}

// ======================================================
// 🎭 EMOTIONAL MARKERS - Para acolhimento contextual
// ======================================================

function extractEmotionalMarkers(messages, lead) {
    const recentInbound = messages
        .filter(m => m.direction === 'inbound')
        .slice(-5); // Últimas 5 mensagens do usuário
    
    const allText = recentInbound.map(m => (m.content || '').toLowerCase()).join(' ');
    
    const markers = {
        expressedWorry: false,
        expressedUrgency: false,
        expressedConfusion: false,
        expressedFrustration: false,
        painAcknowledged: lead?.qualificationData?.painAcknowledged || false,
        objections: [],
        interests: []
    };
    
    // Detectar preocupação
    const worryPatterns = /\b(preocup|medo|ansios|receio|insegur|aflit|desesper)\b/;
    markers.expressedWorry = worryPatterns.test(allText);
    
    // Detectar urgência
    const urgencyPatterns = /\b(urgente|preciso logo|quanto antes|não aguento mais|tá piorando)\b/;
    markers.expressedUrgency = urgencyPatterns.test(allText);
    
    // Detectar confusão
    const confusionPatterns = /\b(não sei|confuso|não entendi|dúvida|não sei o que fazer)\b/;
    markers.expressedConfusion = confusionPatterns.test(allText);
    
    // Detectar frustração
    const frustrationPatterns = /\b(frustrad|desist|cansei|não adianta|já tentei)\b/;
    markers.expressedFrustration = frustrationPatterns.test(allText);
    
    // Detectar objeções
    if (/\b(caro|não tenho dinheiro|não posso pagar)\b/.test(allText)) {
        markers.objections.push('price');
    }
    if (/\b(não tenho tempo|corrido|agenda cheia)\b/.test(allText)) {
        markers.objections.push('time');
    }
    if (/\b(longe|não consigo ir|transporte)\b/.test(allText)) {
        markers.objections.push('distance');
    }
    
    // Detectar interesses
    if (/\b(quero agendar|quando tem|marca|vaga)\b/.test(allText)) {
        markers.interests.push('booking');
    }
    if (/\b(quanto custa|preço|valor|investimento)\b/.test(allText)) {
        markers.interests.push('pricing');
    }
    if (/\b(como funciona|o que fazem|explica)\b/.test(allText)) {
        markers.interests.push('information');
    }
    
    return markers;
}

// ======================================================
// 📝 EXTRACT LAST TOPICS (Para IA referenciar naturalmente)
// ======================================================

function extractLastTopics(messages) {
    const topics = [];
    
    // Pega últimas 3 mensagens do usuário
    const recentUserMessages = messages
        .filter(m => m.direction === 'inbound')
        .slice(-3);
    
    if (recentUserMessages.length === 0) return topics;
    
    const lastMessage = recentUserMessages[recentUserMessages.length - 1];
    const text = (lastMessage.content || '').toLowerCase();
    const timestamp = lastMessage.timestamp;
    
    // Extrai idade mencionada
    const ageMatch = text.match(/(\d+)\s*(anos?|aninhos?|a)/i);
    if (ageMatch) {
        topics.push({
            type: 'child_age',
            value: `${ageMatch[1]} anos`,
            numericValue: parseInt(ageMatch[1], 10),
            timestamp
        });
    }
    
    // Extrai nome mencionado
    const namePatterns = [
        /meu filho (\w+)/i,
        /minha filha (\w+)/i,
        /o (\w+) tem/i,
        /a (\w+) tem/i,
        /chama (\w+)/i
    ];
    
    for (const pattern of namePatterns) {
        const nameMatch = text.match(pattern);
        if (nameMatch && nameMatch[1].length > 2) {
            topics.push({
                type: 'child_name',
                value: nameMatch[1],
                timestamp
            });
            break;
        }
    }
    
    // Extrai queixa/sintoma
    const complaintPatterns = [
        /(nao fala|nao anda|atraso|dificuldade|autismo|tea|tdah|hiperatividade)/i,
        /(troca letras|gagueira|medo|ansiedade)/i,
        /(nao obedece|birra|birração)/i
    ];
    
    for (const pattern of complaintPatterns) {
        const complaintMatch = text.match(pattern);
        if (complaintMatch) {
            topics.push({
                type: 'complaint',
                value: complaintMatch[1],
                timestamp
            });
            break;
        }
    }
    
    // Extrai emoção expressa
    const emotionPatterns = [
        { pattern: /(preocupada|preocupado|medo|ansiosa)/i, emotion: 'preocupação' },
        { pattern: /(frustrada|frustrado|irritada)/i, emotion: 'frustração' },
        { pattern: /(urgente|preciso logo|desesperada)/i, emotion: 'urgência' }
    ];
    
    for (const { pattern, emotion } of emotionPatterns) {
        if (pattern.test(text)) {
            topics.push({
                type: 'emotion',
                value: emotion,
                timestamp
            });
            break;
        }
    }
    
    // Extrai horário mencionado
    const timeMatch = text.match(/(\d{1,2})\s*h/i);
    if (timeMatch) {
        topics.push({
            type: 'preferred_time',
            value: `${timeMatch[1]}h`,
            numericValue: parseInt(timeMatch[1], 10),
            timestamp
        });
    }
    
    return topics;
}

// ======================================================
// 🔧 FUNÇÕES AUXILIARES
// ======================================================

function determineLeadStage(lead, messages, appointments) {
    if (!lead) return 'unknown';
    if (lead.convertedToPatient) return 'paciente';
    if (appointments && appointments.length > 0) return 'interessado_agendamento';
    if (lead.stage) return lead.stage;
    if (lead.status === 'engajado') return 'engajado';
    if (lead.status === 'agendado') return 'interessado_agendamento';
    if ((messages?.length || 0) > 3) return 'engajado';
    return 'novo';
}

/**
 * 🎨 Determina o modo de tom (do ContextPack.js)
 */
function determineToneMode({ lead, lastUserMessage }) {
    const text = (lastUserMessage?.content || '').toLowerCase();
    const messageLength = text.length;

    // Prioridade 1 — Emoção / Medo explícito
    const emotionalKeywords = ['preocup', 'medo', 'insegur', 'ansios', 'receio', 'desesper', 'aflita', 'com medo'];
    const hasEmotionalLanguage = emotionalKeywords.some(word => text.includes(word)) ||
        lead?.clinicalFlags?.includes("ansiedade") ||
        lead?.clinicalFlags?.includes("medo");

    if (hasEmotionalLanguage) return "acolhimento";

    // Prioridade 2 — Contexto clínico sensível
    if (lead?.mentionsChild === true || lead?.mentionsTEA === true ||
        lead?.mentionsDoubtTEA === true || lead?.ageGroup === "bebê" ||
        messageLength > 300) {
        return "acolhimento";
    }

    // Prioridade 3 — Perfil decisor / Adulto
    const isAdultDecisor = lead?.mentionsAdult === true ||
        lead?.segment === "decisor" ||
        lead?.score >= 70 ||
        /quanto custa|valor|preço|agenda|horário/i.test(text);

    if (isAdultDecisor) return "premium";

    return "acolhimento";
}

/**
 * ⚡ Determina nível de urgência
 */
function determineUrgencyLevel(lead) {
    if (lead?.clinicalFlags?.includes("crise")) return "ALTA";
    if (lead?.ageGroup === "bebê" && lead?.therapyArea === "fonoaudiologia") return "ALTA";
    return lead?.urgencyLevel || "NORMAL";
}

/**
 * 🔍 Detecta padrões de comportamento (do contextMemory.js)
 */
function detectBehaviorPatterns(messages) {
    if (!messages || messages.length < 2) {
        return {
            avgResponseTime: 0,
            engagementLevel: 'low',
            asksPriceMultipleTimes: false,
            showsUrgency: false
        };
    }

    const patterns = {
        avgResponseTime: 0,
        engagementLevel: 'low',
        asksPriceMultipleTimes: false,
        showsUrgency: false
    };

    const inbound = messages.filter(m => m.direction === 'inbound');
    let totalTime = 0;
    let count = 0;

    for (let i = 1; i < inbound.length; i++) {
        const diff = new Date(inbound[i].timestamp) - new Date(inbound[i - 1].timestamp);
        if (diff < 24 * 60 * 60 * 1000) {
            totalTime += diff;
            count++;
        }
    }

    if (count > 0) {
        patterns.avgResponseTime = Math.round(totalTime / count / 1000 / 60);
    }

    if (messages.length > 10) patterns.engagementLevel = 'high';
    else if (messages.length > 5) patterns.engagementLevel = 'medium';

    patterns.asksPriceMultipleTimes = messages.filter(m =>
        m.direction === 'inbound' && /\b(pre[cç]o|valor)/i.test(m.content)
    ).length > 1;

    patterns.showsUrgency = messages.some(m =>
        m.direction === 'inbound' && /\b(urgente|r[aá]pido)/i.test(m.content)
    );

    return patterns;
}

function extractMentionedTherapies(messages) {
    const text = (messages || [])
        .map(m => m.content || '')
        .join(' ')
        .toLowerCase();

    const therapies = [];
    const map = [
        { key: 'fonoaudiologia', patterns: ['fono', 'fonoaudiolog'] },
        { key: 'psicologia', patterns: ['psico', 'psicolog'] },
        { key: 'terapia ocupacional', patterns: ['to', 'terapia ocup'] },
        { key: 'fisioterapia', patterns: ['fisio'] },
        { key: 'neuropsicologia', patterns: ['neuropsic'] },
    ];

    for (const item of map) {
        if (item.patterns.some(p => text.includes(p))) therapies.push(item.key);
    }

    return therapies;
}

function calculateDaysSince(date) {
    if (!date) return 999;
    const diff = Date.now() - new Date(date).getTime();
    return Math.floor(diff / (1000 * 60 * 60 * 24));
}

function extractChildAge(lead) {
    if (lead?.knownFacts?.childAge) return parseInt(lead.knownFacts.childAge);
    if (lead?.qualificationData?.childAge) return parseInt(lead.qualificationData.childAge);
    if (lead?.childData?.age) return parseInt(lead.childData.age);

    const summary = lead?.conversationSummary || "";
    const ageMatch = summary.match(/(\d+)\s*(?:anos?|anos de idade)/i);
    if (ageMatch) return parseInt(ageMatch[1]);

    return null;
}

// ======================================================
// 📝 TEMPLATES WARM RECALL
// ======================================================

function generate24hRecall({ parentName, childName, isDevelopmentalWindow }) {
    const templates = [
        `Oi${parentName ? ", " + parentName : ""}! 👋\n\nPassando para relembrar que estou aqui quando precisar. Sei que a rotina é intensa e às vezes a mensagem acaba ficando pra depois.${childName ? ` O ${childName} está bem?` : ""}\n\nQuando sentir que é o momento certo, estou por aqui para ajudar 💚`,
        `${parentName ? parentName + ", " : ""}queria tocar base com você 💚\n\nSem pressa nenhuma — sei que tem mil coisas na cabeça. Só queria que soubesse que não esqueci de vocês.${childName ? ` Como vai o ${childName}?` : ""}\n\nQuando puder, me conta como está a situação 🤗`,
    ];
    return templates[Math.floor(Math.random() * templates.length)];
}

function generate48hRecall({ parentName, childName, childAge, isDevelopmentalWindow, therapyType }) {
    if (isDevelopmentalWindow && childAge !== null) {
        const templates = [
            `${parentName ? parentName + ", " : ""}fiquei pensando no que conversamos sobre o${childName ? " " + childName : " seu filho"} 💚\n\nSei que está corrido, mas nessa idade (${childAge} anos), cada semana que passa é uma oportunidade de desenvolvimento que não volta da mesma forma. Não quero pressionar — só quero que saiba que quanto antes iniciarmos, mais leve será o caminho dele.\n\nEstou aqui quando sentir que é o momento 🤗`,
            `Oi${parentName ? ", " + parentName : ""}! 💚\n\nNão sei se te contaram, mas trabalho com uma clínica que realmente se importa com o tempo das crianças. Com ${childAge} anos, a ${therapyType} tem um impacto diferente — não é alarme, é ciência. As janelas de desenvolvimento são mais receptivas agora.\n\nSe quiser conversar sobre isso, estou aqui. Sem pressão, só carinho pelo ${childName || "seu pequeno"} 🤗`,
        ];
        return templates[Math.floor(Math.random() * templates.length)];
    } else {
        const templates = [
            `${parentName ? parentName + ", " : ""}como você está? 💚\n\nSei que passaram alguns dias e a vida não para. Só queria saber se está tudo bem com vocês${childName ? " — e como vai o " + childName : ""}.\n\nQuando quiser retomar nossa conversa sobre a ${therapyType}, estarei aqui. No seu tempo 🤗`,
            `Oi${parentName ? ", " + parentName : ""}! 👋\n\nPassando para dizer que não esqueci de vocês. Sei que decidir sobre ${therapyType} leva tempo, e está tudo bem.${childName ? ` Como o ${childName} está se saindo?` : ""}\n\nEstou aqui quando quiser continuar 💚`,
        ];
        return templates[Math.floor(Math.random() * templates.length)];
    }
}

function generate72hRecall({ parentName, childName, childAge, isDevelopmentalWindow, therapyType }) {
    if (isDevelopmentalWindow && childAge !== null) {
        const templates = [
            `${parentName ? parentName + ", " : ""}preciso ser honesta com você 💚\n\nCom ${childAge} anos, o ${childName || "seu filho"} está em uma fase onde cada mês faz diferença real no desenvolvimento. Não estou dizendo isso para pressionar — estou dizendo porque me importo.\n\nSe for para fazer, quanto antes, melhor para ele. Se não for agora, também tudo bem. Mas não quero que passe mais tempo sem pelo menos saber das opções.\n\nPosso te ajudar com isso? 🤗`,
            `${parentName ? parentName + ", " : ""}vou ser direta: não quero que o ${childName || "seu filho"} perca tempo precioso 💚\n\nCom ${childAge} anos, iniciar a ${therapyType} agora versus daqui 3 meses pode significar 6 meses a menos de acompanhamento no futuro. É matemática, não pressão.\n\nSe ainda está em dúvida, que tal uma conversa rápida? Mesmo que seja só para tirar dúvidas. Estou aqui 🤗`,
        ];
        return templates[Math.floor(Math.random() * templates.length)];
    } else {
        const templates = [
            `${parentName ? parentName + ", " : ""}passando para um último toque 💚\n\nSei que a vida é corrida e às vezes a gente acaba deixando as coisas para depois. Mas queria que soubesse que estou aqui se precisar${childName ? " do " + childName : ""}.\n\nNossa ${therapyType} pode fazer diferença — quando você estiver pront${parentName ? "a" : "o"}, estarei aqui 🤗`,
            `Oi${parentName ? ", " + parentName : ""}! 💚\n\nNão quero incomodar, mas também não quero que ache que te esqueci. Sei que decidir sobre ${therapyType} não é simples.\n\nSe quiser conversar, estou aqui. Se não for agora, sem problemas — a porta está aberta 🤗`,
        ];
        return templates[Math.floor(Math.random() * templates.length)];
    }
}

function getDefaultContext() {
    return {
        leadId: null,
        leadName: null,
        leadFirstName: null,
        phone: null,
        origin: null,

        hasAppointments: false,
        isPatient: false,
        conversionScore: 0,
        status: 'novo',
        stage: 'novo',

        mode: 'commercial',
        toneMode: 'acolhimento',
        urgencyLevel: 'NORMAL',
        knownFacts: {},
        lastAgreement: null,

        recentMessages: [],
        lastUserMessage: null,
        lastAmandaMessage: null,

        messageCount: 0,
        lastInteraction: null,
        daysSinceLastContact: 999,
        behaviorPatterns: {
            avgResponseTime: 0,
            engagementLevel: 'low',
            asksPriceMultipleTimes: false,
            showsUrgency: false
        },

        patientAge: null,
        ageGroup: null,
        preferredTime: null,
        primaryComplaint: null,
        complaint: null,

        chosenSlot: null,
        pendingChosenSlot: null,
        pendingSchedulingSlots: null,
        pendingSlots: null,

        autoBookingContext: null,
        therapyArea: null,

        conversationHistory: [],
        conversationSummary: null,
        shouldGreet: true,

        mentionedTherapies: [],

        isFirstContact: true,
        isReturning: false,
        needsUrgency: false,

        futureAppointmentsCount: 0,
        appointmentsInfo: null,

        appointmentWarning: '⚠️ ATENÇÃO: Este lead NÃO possui agendamentos futuros. NÃO mencione consultas marcadas ou confirmadas.',

        _debug: null
    };
}

export default enrichLeadContext;
