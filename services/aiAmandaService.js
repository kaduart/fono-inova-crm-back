import axios from "axios";
import OpenAI from "openai";
import { Readable } from "stream";

// ✅ Orquestradores para fallback (quando LLM falha)
import { SYSTEM_PROMPT_AMANDA } from "../utils/amandaPrompt.js";
import ensureSingleHeart from "../utils/helpers.js";
import callAI from "./IA/Aiproviderservice.js";
import { loadContext } from "./intelligence/ContextManager.js";
import { analyzeLeadMessage } from "./intelligence/leadIntelligence.js";
import { getMediaBuffer } from "./whatsappMediaService.js";
import WhatsAppOrchestratorV7 from "../orchestrators/WhatsAppOrchestrator.js";

const orchestrator = new WhatsAppOrchestratorV7();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* =========================================================================
   🎯 REGRA DE OURO - AMANDA CONSULTORA (Não robô de formulário)
   =========================================================================
   
   PRINCÍPIO: Amanda é uma CONSULTORA DE CLÍNICA, não um atendente de telemarketing.
   
   Ela deve:
   1. ENTENDER qualquer dor/queixa que o paciente trouxer (genérico)
   2. ACOLHER com empatia genuína (não script)
   3. CONDUZIR naturalmente para o agendamento (sem forçar)
   4. FLUIR como conversa humana (sem steps rígidos)
   
   NUNCA:
   - Repetir a mesma pergunta
   - Ignorar o que o paciente disse
   - Parecer robô de formulário
   - Forçar dados que o paciente não quer dar ainda
*/

/* =========================================================================
   🧠 FUNÇÃO PRINCIPAL - callAI como CAMADA PRINCIPAL
   ========================================================================= */

export async function generateAmandaReply({ userText, lead = {}, context = {} }) {
    // 🎯 ESTRATÉGIA: LLM primeiro (inteligente), regras só como fallback

    try {
        const systemPrompt = buildConsultoraPrompt(lead);

        // Pega histórico recente para contexto conversacional
        const history = await loadConversationHistory(lead._id, 6);

        const messages = buildMessagesWithHistory(history, userText);

        const aiResponse = await callAI({
            systemPrompt,
            messages,
            maxTokens: 500,
            temperature: 0.8 // Mais criativo/natural
        });

        if (aiResponse) {
            console.log('✅ [AmandaLLM] Resposta natural gerada');
            return ensureSingleHeart(aiResponse);
        }

    } catch (err) {
        console.warn('⚠️ [AmandaLLM] Fallback para regras:', err.message);
    }

    // Fallback para orquestrador baseado em regras
    return generateRuleBasedReply({ userText, lead, context });
}

/* =========================================================================
   📝 PROMPT DA CONSULTORA (Genérico para QUALQUER assunto)
   ========================================================================= */

function buildConsultoraPrompt(lead) {
    // Extrai dados que já temos do lead (se houver)
    const nomePaciente = lead?.patientName || lead?.qualificationData?.extractedInfo?.nome;
    const idade = lead?.patientAge || lead?.qualificationData?.extractedInfo?.idade;
    const especialidade = lead?.therapyArea || lead?.qualificationData?.extractedInfo?.especialidade;

    return `Você é Amanda, recepcionista SÊNIOR da Clínica Fono Inova em Anápolis/GO.

🎯 SEU PAPEL: Consultora de atendimento, não robô de formulário.

📋 INFORMAÇÕES DA CLÍNICA (use quando relevante):
- Especialidades: Fonoaudiologia, Psicologia, Fisioterapia, Terapia Ocupacional, Psicopedagogia, Neuropsicologia, Musicoterapia
- Valores: Avaliações R$200 (Neuropsicologia R$400)
- Horário: Segunda a Sexta, 8h às 18h (não atendemos à noite)
- Endereço: Av. Brasil, 1234 - Centro, Anápolis/GO
- Planos: Reembolso de todos os convênios (IPASGO, Unimed, Amil, etc)
- Pagamento: Pix, cartão, dinheiro

💬 DADOS JÁ COLETADOS DESTE PACIENTE:
${nomePaciente ? `- Nome: ${nomePaciente}` : '- Nome: ainda não informado'}
${idade ? `- Idade: ${idade} anos` : ''}
${especialidade ? `- Interesse: ${especialidade}` : ''}

🚨 REGRAS DE OURO (obrigatórias):

1. **SEJA HUMANA PRIMEIRO**
   - Acolha a dor/queixa do paciente ANTES de qualquer coisa
   - Use empatia genuína, não scripts
   - Frases curtas, natural, 1-2 emojis no máximo

2. **ENTENDA QUALQUER ASSUNTO**
   - O paciente pode chegar com: "meu filho não fala", "quanto custa?", "vocês atendem TDAH?", "estou depressiva", "quero agendar"
   - Identifique a DOR/DEMANDA principal e valide
   - NUNCA ignore o que ele disse para seguir um script

3. **NUNCA REPITA A MESMA PERGUNTA**
   - Se ele não respondeu algo, VARIE a abordagem
   - Ou então responda o que ELE perguntou primeiro
   - "Tem?" → "Sim, temos sim! 😊 E qual o nome do pequeno?"

4. **CONDUÇÃO SUTÍL PARA AGENDAMENTO**
   - Não force dados (nome/idade) se o paciente ainda está na dúvida
   - Primeiro ACOLHA, depois INFORME, depois CONVIDE para agendar
   - Exemplo: "Entendo que está preocupada... A gente ajuda bastante com isso! Quer que eu verifique os horários disponíveis?"

5. **NÃO ENGESSE**
   - Não precisa seguir ordem: nome → idade → período → agendar
   - Se ele mandar tudo de uma vez ("João, 5 anos, de tarde"), aceite e confirme
   - Se ele mudar de assunto, siga com ele e retome depois

6. **DADOS FALTANTES = PERGUNTA NATURAL**
   - Detecte se é CRIANÇA (menção a filho/filha/bebê) ou ADULTO ("para mim", "eu")
   - Criança: "E o pequeno, como se chama?"
   - Adulto: "E você, como posso te chamar?"
   - Natural: "Qual idade? Assim vejo os profissionais mais indicados"

7. **SE JÁ TEM OS DADOS, NÃO PEÇA DE NOVO**
   - Se o contexto mostra nome/idade, USE eles e avance

🎯 TOM DE VOZ:
- Carinhosa mas profissional
- Direta mas gentil
- NUNCA robótica ou burocrática
- Como uma recepcionista experiente que trabalha há anos na clínica

Responda naturalmente, como se estivesse conversando no WhatsApp.`;
}

/* =========================================================================
   📝 HELPERS
   ========================================================================= */

async function loadConversationHistory(leadId, limit = 6) {
    try {
        const { default: Message } = await import('../models/Message.js');

        const messages = await Message.find({
            $or: [
                { lead: leadId },
                { 'metadata.leadId': leadId?.toString() }
            ]
        })
            .sort({ timestamp: -1 })
            .limit(limit)
            .lean();

        return messages.reverse().map(m => ({
            role: m.direction === 'inbound' ? 'user' : 'assistant',
            content: (m.content || m.text || '').toString().substring(0, 200)
        }));
    } catch (e) {
        return [];
    }
}

function buildMessagesWithHistory(history, currentMessage) {
    const messages = [];

    // Adiciona histórico (últimas interações)
    for (const h of history) {
        messages.push({ role: h.role, content: h.content });
    }

    // Adiciona mensagem atual
    messages.push({ role: 'user', content: currentMessage });

    return messages;
}

/* =========================================================================
   🔄 FALLBACK BASEADO EM REGRAS (quando LLM falha)
   ========================================================================= */

async function generateRuleBasedReply({ userText, lead = {}, context = {} }) {
    try {
        // 🆕 USAR V7 (Response-First) como fallback principal
        console.log('🔄 [Fallback] Usando Orchestrator V7 (Response-First)');

        // Carrega contexto persistido do banco
        const persistedContext = await loadContext(lead._id);

        // Merge com dados do lead
        const enrichedContext = {
            ...persistedContext,
            preferredPeriod: lead?.pendingPreferredPeriod || lead?.qualificationData?.extractedInfo?.disponibilidade,
            preferredDate: lead?.qualificationData?.extractedInfo?.dataPreferida,
            therapy: lead?.therapyArea || lead?.qualificationData?.extractedInfo?.especialidade || persistedContext.therapy,
            patientName: lead?.patientName || lead?.qualificationData?.extractedInfo?.nome || persistedContext.patientName,
            age: lead?.patientAge || lead?.qualificationData?.extractedInfo?.idade || persistedContext.age,
            complaint: lead?.complaint || lead?.qualificationData?.extractedInfo?.queixa || persistedContext.complaint,
            source: context?.source || 'api'
        };

        const result = await orchestrator.process({
            lead,
            message: { content: userText },
            context: enrichedContext
        });

        if (result?.command === 'SEND_MESSAGE' && result?.payload?.text) {
            console.log('✅ [Fallback] V7 respondeu com sucesso');
            return ensureSingleHeart(result.payload.text);
        }

        throw new Error('Empty V7 orchestrator response');

    } catch (err) {
        console.warn('⚠️ V7 Orchestrator falhou, tentando V6 legado:', err.message);

        // Fallback para V6 (legado)
        try {
            // O V6 agora gerencia seu próprio contexto internamente
            const result = await orchestrator.process({
                lead,
                message: { content: userText }
            });

            if (result?.command === 'SEND_MESSAGE' && result?.payload?.text) {
                return ensureSingleHeart(result.payload.text);
            }

        } catch (e) {
            console.warn('⚠️ V6 também falhou, usando OpenAI fallback:', e.message);
        }

        // Último fallback: OpenAI direto
        try {
            const fallback = await callOpenAIFallback({
                systemPrompt: SYSTEM_PROMPT_AMANDA,
                messages: [{ role: "user", content: userText }]
            });

            if (fallback) return ensureSingleHeart(fallback);

        } catch (e) {
            console.error("❌ Fallback OpenAI falhou:", e.message);
        }

        // Último recurso: mensagem padrão
        return "Oi! Sou a Amanda da Fono Inova 💚 Que bom que entrou em contato! Me conta: o que está acontecendo que te trouxe aqui hoje?";
    }
}

/* =========================================================================
   📞 FOLLOW-UP (mantido do original)
   ========================================================================= */
export async function generateFollowupMessage(lead) {
    const name = lead?.name?.split(" ")[0] || "tudo bem";
    const reason = (lead?.reason || "avaliação/terapia").trim();
    const origin = lead?.origin || "WhatsApp";

    const lastInteraction = Array.isArray(lead?.interactions) && lead.interactions.length > 0
        ? lead.interactions[lead.interactions.length - 1]
        : null;

    const lastMsg = (lastInteraction?.message || "").trim();
    const lastMsgDesc = lastMsg || reason || "há alguns dias vocês conversaram sobre avaliação/terapia";

    const lastAt = lead.lastInteractionAt ? new Date(lead.lastInteractionAt).getTime() : null;
    const now = Date.now();
    const daysSinceLast = lastAt ? Math.round((now - lastAt) / (1000 * 60 * 60 * 24)) : null;

    let analysis = null;
    try {
        analysis = await analyzeLeadMessage({
            text: lastMsgDesc,
            lead,
            history: Array.isArray(lead.interactions) ? lead.interactions : [],
        });
    } catch (err) {
        console.error("⚠️ Erro em analyzeLeadMessage no follow-up:", err.message);
    }

    const score = analysis?.leadScore?.value ?? lead.leadScore ?? 50;
    const sentiment = analysis?.sentiment?.label ?? "neutral";
    const urgency = analysis?.urgency ?? "medium";

    let tone = "gentil";
    if (score >= 80 && urgency === "high") tone = "empática+urgente";
    else if (score >= 70) tone = "empática";
    else if (score >= 50) tone = "informativa";
    else tone = "educativa";

    const followupSystemPrompt = `Você é Amanda, da Fono Inova.
TOM: ${tone}.
CONTEXT: Lead tem ${daysSinceLast || "alguns"} dias sem interação. Último contato: "${lastMsgDesc}".`;

    const prompt = `Crie uma mensagem de follow-up curta (máx 2 frases) para ${name}. 
Deve parecer natural, não robótica. Pergunte se ainda tem interesse ou se há algo novo.`;

    try {
        const aiResponse = await callAI({
            systemPrompt: followupSystemPrompt,
            messages: [{ role: "user", content: prompt }],
            maxTokens: 150,
            temperature: 0.7
        });

        if (aiResponse) {
            return ensureSingleHeart(aiResponse);
        }
    } catch (err) {
        console.warn("⚠️ AI follow-up falhou, usando template:", err.message);
    }

    const templates = {
        "empática+urgente": `Oi ${name}! 💚 Estamos com vagas disponíveis essa semana e lembrei de vocês. Ainda querem agendar?`,
        "empática": `Oi ${name}! 😊 Como vão? Me conta se ainda estão pensando em dar aquele passo importante para o ${reason}.`,
        "informativa": `Oi ${name}! 💚 Passando para lembrar que estamos aqui quando precisarem. Qualquer dúvida, é só chamar!`,
        "educativa": `Oi! Aqui é a Amanda da Fono Inova. Vimos que vocês deram uma pausa na conversa. Se quiserem retomar, estamos por aqui! 💚`
    };

    return ensureSingleHeart(templates[tone] || templates["informativa"]);
}

/* =========================================================================
   📞 FUNÇÕES DE MÍDIA E UTILITÁRIAS (mantidas do original)
   ========================================================================= */

export async function describeWaImage({ mediaUrl, mimeType, mediaId }) {
    try {
        let finalBuffer, finalMime;

        if (mediaId && !mediaUrl) {
            console.log("🔍 [describeWaImage] Usando mediaId para buscar mídia");
            const mediaBuffer = await getMediaBuffer(mediaId);
            if (!mediaBuffer) throw new Error("Não foi possível obter o buffer da mídia");
            finalBuffer = mediaBuffer.buffer || mediaBuffer;
            finalMime = mediaBuffer.mimeType || mimeType;
        } else if (mediaUrl) {
            console.log("🔍 [describeWaImage] Usando mediaUrl para download");
            const response = await axios.get(mediaUrl, { responseType: "arraybuffer", timeout: 10000 });
            finalBuffer = Buffer.from(response.data, "binary");
            finalMime = mimeType || response.headers["content-type"] || "image/jpeg";
        } else {
            throw new Error("É necessário fornecer mediaUrl ou mediaId");
        }

        const MAX_SIZE = 4.5 * 1024 * 1024;
        let processedBuffer = finalBuffer;
        if (finalBuffer.length > MAX_SIZE) {
            console.log(`⚠️ Imagem muito grande (${(finalBuffer.length / 1024 / 1024).toFixed(2)}MB), truncando...`);
            processedBuffer = finalBuffer.slice(0, MAX_SIZE);
        }

        const system = "Descreva brevemente a imagem para uma recepcionista de clínica de saúde. Foque no que pode ser relevante (ex: criança, documento, etc).";
        const userMessage = { type: "image_url", image_url: { url: `data:${finalMime};base64,${processedBuffer.toString("base64")}` } };

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "system", content: system }, { role: "user", content: [userMessage, { type: "text", text: "Descreva esta imagem:" }] }],
            max_tokens: 200,
        });

        return completion.choices?.[0]?.message?.content?.trim() || "[imagem recebida]";
    } catch (err) {
        console.error("❌ Erro ao descrever imagem:", err.message);
        return "[imagem recebida]";
    }
}

export async function transcribeWaAudio({ mediaUrl, mimeType, mediaId }) {
    try {
        let finalBuffer, finalMime;

        if (mediaId && !mediaUrl) {
            const mediaBuffer = await getMediaBuffer(mediaId);
            if (!mediaBuffer) throw new Error("Não foi possível obter o buffer do áudio");
            finalBuffer = mediaBuffer.buffer || mediaBuffer;
            finalMime = mediaBuffer.mimeType || mimeType || "audio/ogg";
        } else if (mediaUrl) {
            const response = await axios.get(mediaUrl, { responseType: "arraybuffer", timeout: 15000 });
            finalBuffer = Buffer.from(response.data, "binary");
            finalMime = mimeType || response.headers["content-type"] || "audio/ogg";
        } else {
            throw new Error("É necessário fornecer mediaUrl ou mediaId");
        }

        const extension = finalMime.includes("mp4") ? "m4a" : (finalMime.split("/")[1] || "ogg");
        const audioFile = new Readable();
        audioFile.push(finalBuffer);
        audioFile.push(null);

        const response = await openai.audio.transcriptions.create({
            file: audioFile,
            model: "whisper-1",
        });

        return response.text || "";
    } catch (err) {
        console.error("❌ Erro ao transcrever áudio:", err.message);
        return "";
    }
}

export async function callOpenAIFallback({ systemPrompt, messages, maxTokens = 200, temperature = 0.7 }) {
    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: systemPrompt },
                ...messages
            ],
            max_tokens: maxTokens,
            temperature: temperature,
        });

        return completion.choices?.[0]?.message?.content?.trim() || null;
    } catch (err) {
        console.error("❌ callOpenAIFallback falhou:", err.message);
        return null;
    }
}

export default { generateAmandaReply, generateFollowupMessage, describeWaImage, transcribeWaAudio, callOpenAIFallback };
