import Anthropic from "@anthropic-ai/sdk";
import 'dotenv/config';
import Appointment from '../models/Appointment.js';
import Lead from '../models/Leads.js';
import Message from '../models/Message.js';
import enrichLeadContext from "../services/leadContext.js";
import { getManual } from './amandaIntents.js';
import { generateConversationSummary, needsNewSummary } from './conversationSummary.js';
import { detectAllFlags } from './flagsDetector.js';
import { buildEquivalenceResponse } from './responseBuilder.js';
import {
    detectAllTherapies,
    getTDAHResponse,
    isAskingAboutEquivalence,
    isTDAHQuestion
} from './therapyDetector.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * 🎯 ORQUESTRADOR COM CONTEXTO LEVE
 */
export async function getOptimizedAmandaResponse({ content, userText, lead = {}, context = {} }) {
    const text = userText || content || "";
    const normalized = text.toLowerCase().trim();

    console.log(`🎯 [ORCHESTRATOR] Processando: "${text}"`);

    // ✅ CONTEXTO LEVE (busca dados que JÁ EXISTEM no banco)
    const enrichedContext = lead._id
        ? await enrichLeadContext(lead._id)
        : { ...context, stage: 'novo', isFirstContact: true, messageCount: 0 };

    // ===== 1. TDAH - RESPOSTA ESPECÍFICA =====
    if (isTDAHQuestion(text)) {
        console.log('🧠 [TDAH] Pergunta sobre tratamento TDAH detectada');
        return getTDAHResponse(lead?.name);
    }

    // ===== 2. TERAPIAS ESPECÍFICAS =====  ← RENUMERAR (antes era 1)
    const therapies = detectAllTherapies(text);

    if (therapies.length > 0) {
        console.log(`🎯 [TERAPIAS] Detectadas: ${therapies.map(t => t.id).join(', ')}`);

        // ✅ Busca flags
        const flags = detectAllFlags(text, lead, enrichedContext);

        console.log(`🏁 [FLAGS]`, {
            asksPrice: flags.asksPrice,
            wantsSchedule: flags.wantsSchedule,
            userProfile: flags.userProfile
        });

        // ✅ CHAMA IA COM DADOS DAS TERAPIAS (não resposta fixa)
        const aiResponse = await callClaudeWithTherapyData({
            therapies,
            flags,
            userText: text,
            lead,
            context: enrichedContext
        });

        return ensureSingleHeart(aiResponse);
    }

    // ===== 3. EQUIVALÊNCIA =====
    if (isAskingAboutEquivalence(text)) {
        return buildEquivalenceResponse();
    }

    // ===== 4. MANUAL =====
    const manualResponse = tryManualResponse(normalized);
    if (manualResponse) {
        console.log(`✅ [ORCHESTRATOR] Resposta do manual`);
        return ensureSingleHeart(manualResponse);
    }

    // ===== 4. IA COM CONTEXTO =====
    console.log(`🤖 [ORCHESTRATOR] IA | Stage: ${enrichedContext.stage} | Msgs: ${enrichedContext.messageCount}`);
    try {
        const aiResponse = await callOpenAIWithContext(text, lead, enrichedContext);
        return ensureSingleHeart(aiResponse);
    } catch (error) {
        console.error(`❌ [ORCHESTRATOR] Erro na IA:`, error.message);
        return "Vou verificar e já te retorno, por favor um momento 💚";
    }
}

export async function enrichLeadContext(leadId) {
    try {
        const lead = await Lead.findById(leadId)
            .populate('contact')
            .lean();

        if (!lead) {
            return getDefaultContext();
        }

        // ✅ Busca TODAS as mensagens (não limita mais)
        const messages = await Message.find({
            lead: leadId,
            type: 'text'
        })
            .sort({ timestamp: 1 }) // Ordem cronológica
            .lean();

        const totalMessages = messages.length;

        // ✅ Busca agendamentos
        const appointments = await Appointment.find({
            patient: lead.convertedToPatient
        }).lean();

        // 🧠 LÓGICA DE CONTEXTO INTELIGENTE
        let conversationHistory = [];
        let shouldGreet = true;
        let summaryContext = null;

        if (totalMessages === 0) {
            // Primeira mensagem ever
            conversationHistory = [];
            shouldGreet = true;
        }
        else if (totalMessages <= 20) {
            // Conversa curta: manda tudo
            conversationHistory = messages.map(msg => ({
                role: msg.direction === 'inbound' ? 'user' : 'assistant',
                content: msg.content,
                timestamp: msg.timestamp
            }));

            // Checa se deve cumprimentar (última msg >24h atrás)
            const lastMsgTime = messages[messages.length - 1].timestamp;
            const hoursSince = (Date.now() - new Date(lastMsgTime)) / (1000 * 60 * 60);
            shouldGreet = hoursSince > 24;
        }
        else {
            // Conversa longa (>20): resumo + últimas 20

            // 1. Verifica se precisa gerar novo resumo
            let leadDoc = await Lead.findById(leadId); // Busca versão mutável

            if (needsNewSummary(lead, totalMessages)) {
                console.log(`🧠 [CONTEXTO] Gerando resumo (${totalMessages} msgs)`);

                // Mensagens antigas (todas menos últimas 20)
                const oldMessages = messages.slice(0, -20);

                // Gera resumo
                const summary = await generateConversationSummary(oldMessages);

                if (summary) {
                    // Salva resumo no lead
                    await leadDoc.updateOne({
                        conversationSummary: summary,
                        summaryGeneratedAt: new Date(),
                        summaryCoversUntilMessage: totalMessages - 20
                    });

                    summaryContext = summary;
                    console.log(`💾 [CONTEXTO] Resumo salvo (cobre ${oldMessages.length} msgs antigas)`);
                }
            } else {
                // Reusa resumo existente
                summaryContext = lead.conversationSummary;
                console.log(`♻️ [CONTEXTO] Reutilizando resumo existente`);
            }

            // 2. Últimas 20 mensagens completas
            const recentMessages = messages.slice(-20);
            conversationHistory = recentMessages.map(msg => ({
                role: msg.direction === 'inbound' ? 'user' : 'assistant',
                content: msg.content,
                timestamp: msg.timestamp
            }));

            // 3. Checa saudação
            const lastMsgTime = recentMessages[recentMessages.length - 1].timestamp;
            const hoursSince = (Date.now() - new Date(lastMsgTime)) / (1000 * 60 * 60);
            shouldGreet = hoursSince > 24;
        }

        // ✅ Monta contexto final
        const context = {
            // Dados básicos
            leadId: lead._id,
            name: lead.name,
            phone: lead.contact?.phone,
            origin: lead.origin,

            // Status
            hasAppointments: appointments?.length > 0,
            isPatient: !!lead.convertedToPatient,
            conversionScore: lead.conversionScore || 0,
            status: lead.status,

            // Comportamento
            messageCount: totalMessages,
            lastInteraction: lead.lastInteractionAt,
            daysSinceLastContact: calculateDaysSince(lead.lastInteractionAt),

            // 🆕 CONTEXTO INTELIGENTE
            conversationHistory,      // Array [{role, content, timestamp}]
            conversationSummary: summaryContext, // String com resumo ou null
            shouldGreet,              // Boolean

            // Intenções (mantém pra flags)
            mentionedTherapies: extractMentionedTherapies(messages),

            // Estágio
            stage: determineLeadStage(lead, messages, appointments),

            // Flags úteis
            isFirstContact: totalMessages <= 1,
            isReturning: totalMessages > 3,
            needsUrgency: calculateDaysSince(lead.lastInteractionAt) > 7
        };

        console.log(`📊 [CONTEXTO] Lead: ${context.name} | Stage: ${context.stage} | Msgs: ${context.messageCount} | Resumo: ${summaryContext ? 'SIM' : 'NÃO'} | Saudação: ${shouldGreet ? 'SIM' : 'NÃO'}`);

        return context;

    } catch (error) {
        console.error('❌ [CONTEXTO] Erro:', error);
        return getDefaultContext();
    }
}

// Funções auxiliares permanecem iguais
function determineLeadStage(lead, messages, appointments) {
    if (lead.convertedToPatient || appointments?.length > 0) return 'paciente';
    if (lead.status === 'agendado') return 'agendado';
    if (messages.some(m => /agend|marcar|quero.*consulta/i.test(m.content))) return 'interessado_agendamento';
    if (messages.some(m => /pre[cç]o|valor|quanto.*custa/i.test(m.content))) return 'pesquisando_preco';
    if (messages.length >= 3) return 'engajado';
    if (messages.length > 0) return 'primeiro_contato';
    return 'novo';
}

function extractMentionedTherapies(messages) {
    const therapies = new Set();
    messages.forEach(msg => {
        const content = msg.content?.toLowerCase() || '';
        if (/neuropsic/i.test(content)) therapies.add('neuropsicológica');
        if (/fono/i.test(content)) therapies.add('fonoaudiologia');
        if (/psic[oó]log(?!.*neuro)/i.test(content)) therapies.add('psicologia');
        if (/terapia.*ocupacional|to\b/i.test(content)) therapies.add('terapia ocupacional');
        if (/fisio/i.test(content)) therapies.add('fisioterapia');
        if (/musico/i.test(content)) therapies.add('musicoterapia');
        if (/psicopedagog/i.test(content)) therapies.add('psicopedagogia');
    });
    return Array.from(therapies);
}

function calculateDaysSince(date) {
    if (!date) return 999;
    return Math.floor((Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24));
}

function getDefaultContext() {
    return {
        stage: 'novo',
        isFirstContact: true,
        messageCount: 0,
        mentionedTherapies: [],
        conversationHistory: [],
        conversationSummary: null,
        shouldGreet: true,
        needsUrgency: false
    };
}

/**
 * 📖 MANUAL
 */
function tryManualResponse(normalizedText) {
    if (/\b(endere[cç]o|onde fica|local|mapa|como chegar)\b/.test(normalizedText)) {
        return getManual('localizacao', 'endereco');
    }

    if (/\b(plano|conv[eê]nio|unimed|ipasgo|amil)\b/.test(normalizedText)) {
        return getManual('planos_saude', 'unimed');
    }

    if (/\b(pre[cç]o|valor|quanto.*custa)\b/.test(normalizedText) &&
        !/\b(neuropsic|fono|psico|terapia|fisio|musico)\b/.test(normalizedText)) {
        return getManual('valores', 'consulta');
    }

    if (/^(oi|ol[aá]|boa\s*(tarde|noite|dia)|bom\s*dia)[\s!,.]*$/i.test(normalizedText)) {
        return getManual('saudacao');
    }

    return null;
}

/**
 * 🤖 IA COM DADOS DE TERAPIAS + HISTÓRICO COMPLETO
 */
async function callClaudeWithTherapyData({ therapies, flags, userText, lead, context }) {
    const { getTherapyData } = await import('./therapyDetector.js');
    const { getLatestInsights } = await import('../services/amandaLearningService.js');
    const { SYSTEM_PROMPT_AMANDA } = await import('./amandaPrompt.js');

    const insights = await getLatestInsights();

    const therapiesInfo = therapies.map(t => {
        const data = getTherapyData(t.id);
        return `${t.name.toUpperCase()}: ${data.explanation} | Preço: ${data.price}`;
    }).join('\n');

    const {
        stage, messageCount, isPatient, hasAppointments,
        needsUrgency, daysSinceLastContact,
        conversationHistory, conversationSummary, shouldGreet
    } = context;

    // ✅ INSIGHTS APRENDIDOS
    let learnedContext = '';
    if (insights?.data?.effectivePriceResponses && flags.asksPrice) {
        const scenario = stage === 'novo' ? 'first_contact' : 'engaged';
        const bestResponse = insights.data.effectivePriceResponses.find(r => r.scenario === scenario);
        if (bestResponse) {
            learnedContext = `\n💡 PADRÃO DE SUCESSO: "${bestResponse.response}"`;
        }
    }

    const patientStatus = isPatient ? `\n⚠️ PACIENTE ATIVO - Tom próximo!` : '';
    const urgencyNote = needsUrgency ? `\n🔥 ${daysSinceLastContact} dias sem falar - reative com calor!` : '';

    // 🧠 MONTA MENSAGENS COM HISTÓRICO COMPLETO
    const messages = [];

    // 1. Se tem resumo, adiciona como contexto anterior
    if (conversationSummary) {
        messages.push({
            role: 'user',
            content: `📋 CONTEXTO DE CONVERSAS ANTERIORES:\n\n${conversationSummary}\n\n---\n\nAs mensagens abaixo são a continuação RECENTE desta conversa:`
        });
        messages.push({
            role: 'assistant',
            content: 'Entendi o contexto completo. Vou continuar a conversa de forma natural, lembrando de tudo que foi discutido.'
        });
    }

    // 2. Adiciona histórico recente (últimas 20 msgs)
    messages.push(...conversationHistory);

    // 3. Mensagem atual com instruções
    const currentPrompt = `${userText}

📊 CONTEXTO DESTA MENSAGEM:
TERAPIAS DETECTADAS: ${therapiesInfo}
FLAGS: Preço=${flags.asksPrice} | Agendar=${flags.wantsSchedule}
ESTÁGIO: ${stage} (${messageCount} msgs totais)${patientStatus}${urgencyNote}${learnedContext}

🎯 INSTRUÇÕES CRÍTICAS:
1. ${shouldGreet ? '✅ Pode cumprimentar naturalmente' : '🚨 NÃO USE SAUDAÇÕES (Oi/Olá) - conversa está ativa'}
2. ${conversationSummary ? '🧠 Você TEM o resumo completo acima - USE esse contexto!' : '📜 Leia TODO o histórico de mensagens acima'}
3. 🚨 NÃO PERGUNTE o que JÁ foi informado/discutido
4. ${flags.asksPrice ? 'Responda preço: VALOR→PREÇO→PERGUNTA' : 'Apresente de forma acolhedora'}
5. Máximo 3 frases, tom natural e humano
6. Exatamente 1 💚 no final`;

    messages.push({
        role: 'user',
        content: currentPrompt
    });

    // 🚀 CHAMA ANTHROPIC COM CACHE
    const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 200,
        temperature: 0.7,
        system: [
            {
                type: "text",
                text: SYSTEM_PROMPT_AMANDA,
                cache_control: { type: "ephemeral" }
            }
        ],
        messages
    });

    return response.content[0]?.text?.trim() || "Como posso te ajudar? 💚";
}

/**
 * 🤖 IA COM CONTEXTO INTELIGENTE (SEM TERAPIAS ESPECÍFICAS)
 */
async function callOpenAIWithContext(userText, lead, context) {
    const { SYSTEM_PROMPT_AMANDA } = await import('./amandaPrompt.js');

    const {
        stage = 'novo',
        messageCount = 0,
        mentionedTherapies = [],
        isPatient = false,
        needsUrgency = false,
        daysSinceLastContact = 0,
        conversationHistory = [],
        conversationSummary = null,
        shouldGreet = true
    } = context;

    let stageInstruction = '';
    switch (stage) {
        case 'novo':
            stageInstruction = 'Seja acolhedora. Pergunte necessidade antes de preços.';
            break;
        case 'pesquisando_preco':
            stageInstruction = 'Lead já perguntou valores. Use VALOR→PREÇO→ENGAJAMENTO.';
            break;
        case 'engajado':
            stageInstruction = `Lead trocou ${messageCount} msgs. Seja mais direta.`;
            break;
        case 'interessado_agendamento':
            stageInstruction = 'Lead quer agendar! Ofereça 2 períodos concretos.';
            break;
        case 'paciente':
            stageInstruction = 'PACIENTE ATIVO! Tom próximo.';
            break;
    }

    const patientNote = isPatient ? `\n⚠️ PACIENTE - seja próxima!` : '';
    const urgencyNote = needsUrgency ? `\n🔥 ${daysSinceLastContact} dias sem contato - reative!` : '';
    const therapiesContext = mentionedTherapies.length > 0
        ? `\n🎯 TERAPIAS DISCUTIDAS: ${mentionedTherapies.join(', ')}`
        : '';

    // 🧠 MONTA MENSAGENS
    const messages = [];

    // 1. Resumo se existe
    if (conversationSummary) {
        messages.push({
            role: 'user',
            content: `📋 CONTEXTO ANTERIOR:\n\n${conversationSummary}\n\n---\n\nMensagens recentes abaixo:`
        });
        messages.push({
            role: 'assistant',
            content: 'Entendi o contexto. Continuando...'
        });
    }

    // 2. Histórico recente
    messages.push(...conversationHistory);

    // 3. Mensagem atual
    messages.push({
        role: 'user',
        content: `${userText}

CONTEXTO:
LEAD: ${lead?.name || 'Desconhecido'} | ESTÁGIO: ${stage} (${messageCount} msgs)${therapiesContext}${patientNote}${urgencyNote}

INSTRUÇÃO: ${stageInstruction}

REGRAS:
- ${shouldGreet ? 'Pode cumprimentar' : '🚨 NÃO use Oi/Olá - conversa ativa'}
- ${conversationSummary ? '🧠 USE o resumo acima' : '📜 Leia histórico acima'}
- 🚨 NÃO pergunte o que já foi dito
- 1-3 frases, tom humano
- 1 pergunta engajadora
- 1 💚 final`
    });

    const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 150,
        temperature: 0.6,
        system: [
            {
                type: "text",
                text: SYSTEM_PROMPT_AMANDA,
                cache_control: { type: "ephemeral" }
            }
        ],
        messages
    });

    return response.content[0]?.text?.trim() || "Como posso te ajudar? 💚";
}

/**
 * 🎨 HELPER
* **/
function ensureSingleHeart(text) {
    if (!text) return "Como posso te ajudar? 💚";
    const clean = text.replace(/💚/g, '').trim();
    return `${clean} 💚`;
}

export default getOptimizedAmandaResponse;