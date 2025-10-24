// services/aiAmandaService.js
import OpenAI from "openai";
import { Readable } from "stream";
import {
    CLINIC_ADDRESS,
    POLICY_RULES,
    SYSTEM_PROMPT_AMANDA,
    VALUE_PITCH,
    buildUserPromptWithValuePitch,
    deriveFlagsFromText,
    inferTopic
} from "../utils/amandaPrompt.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* =========================================================================
   Utils de pós-processamento (garantias de formato)
   ========================================================================= */
function stripLinks(text = "") {
    return text.replace(/\bhttps?:\/\/\S+/gi, "").replace(/\s{2,}/g, " ").trim();
}

function clampTo1to3Sentences(text = "") {
    const parts = text.split(/(?<=[.!?])\s+/).filter(Boolean);
    const out = parts.slice(0, 3).join(" ").trim();
    return out || text.trim();
}

function ensureSingleHeartAtEnd(text = "") {
    const noHearts = text.replace(/💚/g, "").trim();
    return `${noHearts} 💚`.replace(/\s{2,}/g, " ").trim();
}

/* =========================================================================
   FUNÇÃO CRÍTICA: Aplicar estratégia VALOR → PREÇO com regras de negócio
   ========================================================================= */
function applyValuePriceStrategy(flags = {}) {
    const { text = "", topic, asksPrice, insistsPrice, isFirstContact } = flags;
    const t = text.toLowerCase();

    // 🚫 REGRA: Nunca dar preço sem contexto na primeira mensagem
    if (!asksPrice && !insistsPrice) {
        return null;
    }

    // 🚫 REGRA: Micro-qualificação para preços genéricos no primeiro contato
    if (isFirstContact && asksPrice && !insistsPrice && topic === "generico") {
        return {
            strategy: "micro_qualification",
            pitch: VALUE_PITCH.generico,
            question: "É para avaliação, sessão ou pacote?"
        };
    }

    const mentionsCDL = /\bcdl\b/i.test(t);
    const asksSession = /\bsess[aã]o\b|sessão|sessao/i.test(t);
    const asksPackage = /\bpacote|mensal\b/i.test(t);
    const asksNeuro = /\bneuropsicol[oó]gica|neuropsico\b/i.test(t);
    const asksLinguinha = /\blinguinha|fr[eê]nulo\b/i.test(t);

    let pitch = "";
    let price = "";
    let strategy = "value_price";

    // 🎯 REGRA: CDL só se mencionado
    if (mentionsCDL) {
        pitch = VALUE_PITCH.avaliacao_inicial;
        price = "A avaliação CDL é R$ 200.";
    }
    // 🎯 REGRA: Neuropsicológica
    else if (asksNeuro) {
        pitch = VALUE_PITCH.neuropsicologica;
        price = "A avaliação neuropsicológica é R$ 2.500 em até 6x no cartão ou R$ 2.300 à vista.";
    }
    // 🎯 REGRA: Teste da Linguinha
    else if (asksLinguinha) {
        pitch = VALUE_PITCH.teste_linguinha;
        price = "O Teste da Linguinha custa R$ 150,00.";
    }
    // 🎯 REGRA: Sessão avulsa vs Pacote
    else if (asksSession) {
        pitch = VALUE_PITCH.sessao;
        // 🎯 REGRA CRÍTICA: Comparar sessão avulsa vs pacote só se perguntarem sessão
        price = "Sessão avulsa R$ 220; no pacote mensal sai por R$ 180 por sessão (~R$ 720/mês).";
    }
    // 🎯 REGRA: Pacote só se perguntar explicitamente
    else if (asksPackage) {
        pitch = VALUE_PITCH.pacote;
        price = "O pacote (1x por semana) sai por R$ 180 por sessão (~R$ 720/mês).";
    }
    // 🎯 REGRA PADRÃO: Avaliação inicial
    else {
        pitch = VALUE_PITCH.avaliacao_inicial;
        price = "A avaliação inicial é R$ 220.";
    }

    return { strategy, pitch, price };
}

/* =========================================================================
   FUNÇÃO PRINCIPAL: generateAmandaReply com TODAS as regras de negócio
   ========================================================================= */
export async function generateAmandaReply({ userText, lead = {}, context = {} }) {
    const text = userText || "";
    const name = lead?.name || "";
    const origin = lead?.origin || "WhatsApp";
    const reason = lead?.reason || "avaliação/terapia";

    // 🔍 Detecção de flags do texto
    const derivedFlags = deriveFlagsFromText(text);

    // 🔍 Determinar se é primeiro contato
    const lastMsgs = Array.isArray(context?.lastMessages) ? context.lastMessages.slice(-5) : [];
    const greetings = /^(oi|ol[aá]|boa\s*(tarde|noite|dia)|tudo\s*bem|bom\s*dia|fala|e[aíi])[\s!,.]*$/i;
    const isFirstContact =
        !!context?.isFirstContact ||
        lastMsgs.length === 0 ||
        greetings.test(text.trim());

    // 🔍 Detectar tópico
    const topic = inferTopic(text);

    // 🔍 Montar objeto de flags completo
    const flags = {
        text,
        name,
        origin,
        reason,
        topic,
        isFirstContact,
        ...derivedFlags
    };

    console.log("🔍 [Amanda Debug] Flags detectadas:", flags);

    // 🚀 CURTO-CIRCUITOS PARA RESPOSTAS ESPECÍFICAS (garantem regras de negócio)

    // 1. Primeiro contato com saudação
    if (isFirstContact && greetings.test(text.trim())) {
        const response = `Oi${name ? `, ${name}` : ''}! Sou a Amanda da Fono Inova. Em que posso te ajudar hoje? 💚`;
        return ensureSingleHeartAtEnd(response);
    }

    // 2. Endereço direto
    if (flags.asksAddress) {
        const response = `Estamos na ${CLINIC_ADDRESS}. Precisa de ajuda com a localização no mapa? 💚`;
        return ensureSingleHeartAtEnd(response);
    }

    // 3. Psicólogo infantil
    if (flags.asksChildPsychology) {
        const response = "Temos psicologia infantil com foco em desenvolvimento emocional e comportamental (TCC e intervenções para neurodesenvolvimento). Posso te ajudar com a avaliação inicial? 💚";
        return ensureSingleHeartAtEnd(response);
    }

    // 4. Convênios
    if (flags.asksPlans) {
        const response = "Estamos em credenciamento (IPASGO, Unimed etc.); no momento atendemos particular de forma humanizada e personalizada. Posso te ajudar com alguma informação? 💚";
        return ensureSingleHeartAtEnd(response);
    }

    // 5. Pagamento (verificação)
    if (flags.asksPayment) {
        const response = "Vou verificar e já te retorno, por favor um momento 💚";
        return ensureSingleHeartAtEnd(response);
    }

    // 6. Horários de funcionamento
    if (flags.asksHours) {
        const response = "Nosso atendimento é de segunda a sexta, geralmente das 8h às 18h. Posso te ajudar a agendar um horário? 💚";
        return ensureSingleHeartAtEnd(response);
    }

    // 🎯 APLICAR ESTRATÉGIA VALOR → PREÇO
    const valuePriceInfo = applyValuePriceStrategy(flags);

    // 🚀 CONSTRUIR PROMPT ESPECÍFICO BASEADO NAS REGRAS
    let customPrompt = "";

    if (valuePriceInfo) {
        if (valuePriceInfo.strategy === "micro_qualification") {
            customPrompt = `
Mensagem do cliente: """${text}"""
Contexto: Primeiro contato, pergunta genérica sobre preço.

REGRA DE NEGÓCIO: Micro-qualificação obrigatória
• NÃO dê preço ainda
• Use: "${valuePriceInfo.pitch}"
• Faça 1 pergunta: "${valuePriceInfo.question}"
• Finalize com convite para continuar

Saída: 2-3 frases, 1 💚 no final
`;
        } else {
            customPrompt = `
Mensagem do cliente: """${text}"""
Contexto: Pedido específico de preço.

REGRA DE NEGÓCIO: Valor → Preço
• Primeiro: "${valuePriceInfo.pitch}"  
• Depois: "${valuePriceInfo.price}"
• Finalize com pergunta de avanço

Saída: 2-3 frases, 1 💚 no final
`;
        }
    } else if (flags.wantsSchedule) {
        customPrompt = `
Mensagem do cliente: """${text}"""
Contexto: Cliente quer agendar.

REGRA DE NEGÓCIO: Agendamento
• Ofereça no máximo 2 janelas: "amanhã à tarde" ou "quinta pela manhã"
• NÃO invente horários específicos
• Finalize confirmando interesse

Saída: 2-3 frases, 1 💚 no final
`;
    } else {
        // Prompt padrão usando a função existente
        customPrompt = buildUserPromptWithValuePitch(flags);
    }

    console.log("🔍 [Amanda Debug] Prompt enviado:", customPrompt);

    // 🚀 CHAMADA PARA OPENAI
    let resp;
    try {
        resp = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            temperature: 0.5,
            max_tokens: 180,
            messages: [
                { role: "system", content: SYSTEM_PROMPT_AMANDA },
                { role: "user", content: customPrompt },
            ],
        });
    } catch (error) {
        console.error("❌ Erro OpenAI:", error);
        // Fallback para garantir resposta
        return generateFallbackResponse(flags);
    }

    let out = resp.choices?.[0]?.message?.content?.trim() || "";

    // 🛡️ PÓS-PROCESSAMENTO DE SEGURANÇA
    out = stripLinks(out);
    out = clampTo1to3Sentences(out);
    out = ensureSingleHeartAtEnd(out);
    // 1) Forçar fluxo "explicação → preço → queixa" quando pedem valor da avaliação
    out = enforceEvalPriceFlow(out, flags);

    // 2) Segurar CTA de agendar até existir sinal
    out = stripCTAIfNoSignal(out, flags);


    // 🔒 REGRAS DE NEGÓCIO (pode ajustar preço/linguagem)
    out = applyBusinessRulesPostProcessing(out, flags);

    // se NÃO houve pedido explícito de agendamento, limpe qualquer CTA duro
    if (!flags?.wantsSchedule) {
        out = removeAgendamentoFrases(out);
    }

    // se houve perguntas do cliente (preço/endereço/pagamento/horários/planos), feche com CTA SUAVE
    if (!flags?.wantsSchedule) {
        out = appendSoftCTAIfHelpful(out, flags);
    }

    // normaliza formato no final
    out = clampTo1to3Sentences(out);
    out = ensureSingleHeartAtEnd(out);

    console.log("🔍 [Amanda Debug] Resposta final:", out);
    return out;
}

// ===== Helpers de fluxo =====

// avalia se podemos liberar CTA suave (sem oferecer horário)
function canSoftCTA(flags = {}) {
    const {
        wantsSchedule,
        asksDetails,       // novo flag (amandaPrompt.js)
        resolvedDoubts,    // novo flag (amandaPrompt.js)
        asksPrice,
        insistsPrice,
    } = (flags || {});
    // libera CTA se: pediu agendar, fez perguntas/detalhes, sinalizou que entendeu,
    // ou ficou perguntando muito sobre preço (engajamento)
    return !!(wantsSchedule || asksDetails || resolvedDoubts || insistsPrice || (asksPrice && asksDetails));
}

// força o formato explicação → preço → pergunta da queixa (para "valor da avaliação")
function enforceEvalPriceFlow(out = "", flags = {}) {
    const t = (flags?.text || "").toLowerCase();
    const askedEvalPrice =
        flags?.asksPrice && /avali(a|á)ç(ã|a)o|fono(audiologia)?|consulta/i.test(t);

    if (!askedEvalPrice) return out;

    // Monta resposta seca e humana (sem CTA ainda)
    const base =
        "Primeiro fazemos uma avaliação para entender a queixa principal e definir o plano terapêutico. O valor da avaliação é R$ 220. Quer me contar qual é a queixa principal para eu orientar melhor?";

    // mantém 1–3 frases e 1 💚 ao fim
    return ensureSingleHeartAtEnd(clampTo1to3Sentences(base));
}

// remove qualquer CTA de agendar quando não há sinal
function stripCTAIfNoSignal(out = "", flags = {}) {
    if (canSoftCTA(flags)) return out;

    // remove frases com 'agend' (agendar/agendamento/agende...), mantendo o resto
    const cleaned = out
        .split(/(?<=[.!?])\s+/)
        .filter(s => !/agend/i.test(s))
        .join(" ")
        .replace(/\s{2,}/g, " ")
        .trim();

    // re-garantias
    return ensureSingleHeartAtEnd(clampTo1to3Sentences(cleaned));
}

function removeAgendamentoFrases(text) {
    return text
        .split(/(?<=[.!?])\s+/)
        .filter(s => !/agend/i.test(s)) // remove agendar/agendamento/agende/agend.
        .join(" ")
        .replace(/\s{2,}/g, " ")
        .trim();
}

function appendSoftCTAIfHelpful(text, flags = {}) {
    const askedAny =
        !!flags.asksPrice ||
        !!flags.asksAddress ||
        !!flags.asksPayment ||
        !!flags.asksHours ||
        !!flags.asksPlans;

    if (!askedAny) return text; // só adiciona quando o cliente realmente perguntou algo

    // não põe coração aqui; o ensureSingleHeartAtEnd entra no final
    const softClose = "Ficou alguma dúvida? Se quiser, posso ajudar com o agendamento.";
    // evita duplicar se o modelo já falou algo muito parecido
    if (new RegExp(softClose.replace(/[.?]/g, "\\$&"), "i").test(text)) return text;

    // acrescenta como última frase
    return [text, softClose].filter(Boolean).join(" ").replace(/\s{2,}/g, " ").trim();
}

/* =========================================================================
   FUNÇÃO DE FALLBACK (para quando a OpenAI falha)
   ========================================================================= */
function generateFallbackResponse(flags) {
    const { text = "", isFirstContact, asksPrice, wantsSchedule, asksAddress } = flags;
    const t = text.toLowerCase();

    if (isFirstContact) {
        return `Oi! Sou a Amanda da Fono Inova. Em que posso te ajudar hoje? 💚`;
    }

    if (asksAddress) {
        return `Estamos na ${CLINIC_ADDRESS}. Precisa de ajuda com a localização? 💚`;
    }

    if (asksPrice) {
        if (/\bcdl\b/.test(t)) {
            return `A avaliação CDL é R$ 200. Posso te ajudar a agendar? 💚`;
        } else if (/\bsess[aã]o\b/.test(t)) {
            return `Sessão avulsa R$ 220; no pacote mensal sai por R$ 180 por sessão. Posso te ajudar? 💚`;
        } else {
            return `A avaliação inicial é R$ 220 e define o melhor plano para você. É para avaliação, sessão ou pacote? 💚`;
        }
    }

    if (wantsSchedule) {
        return `Perfeito! Temos horários amanhã à tarde ou quinta pela manhã. Qual prefere? 💚`;
    }

    return `Vou verificar e já te retorno, por favor um momento 💚`;
}

/* =========================================================================
   APLICAÇÃO DE REGRAS DE NEGÓCIO NO PÓS-PROCESSAMENTO
   ========================================================================= */
function applyBusinessRulesPostProcessing(text, flags) {
    let processed = text;

    // 🚫 REMOVER OFERTAS DE HORÁRIOS QUANDO NÃO SOLICITADO
    if (!flags.wantsSchedule) {
        processed = processed
            .replace(/\b(amanh[aã]|hoje|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo)\b[^.!?\n]{0,30}\b(\d{1,2}h(\d{2})?)\b/gi, "")
            .replace(/\b(\d{1,2}\s*h(\s*\d{2})?)\b/gi, "")
            .replace(/\s{2,}/g, " ")
            .trim();
    }

    // 🚫 REMOVER CDL QUANDO NÃO MENCIONADO
    if (!/\bcdl\b/i.test(flags.text) && /cdl/i.test(processed)) {
        processed = processed.replace(/cdl/gi, "avaliação");
    }

    // 🚫 GARANTIR APENAS 1 EMOJI 💚
    processed = ensureSingleHeartAtEnd(processed);

    return processed;
}

/* =========================================================================
   FUNÇÃO DE FOLLOW-UP (mantida para compatibilidade)
   ========================================================================= */
function personalizeIntro(origin = "") {
    const o = (origin || "").toLowerCase();
    if (o.includes("google")) return "Vimos seu contato pelo Google e ficamos felizes em ajudar. ";
    if (o.includes("instagram") || o.includes("facebook") || o.includes("meta"))
        return "Recebemos sua mensagem pelo Instagram, que bom falar com você! ";
    if (o.includes("indica")) return "Agradecemos a indicação! ";
    return "";
}

export async function generateFollowupMessage(lead) {
    const name = lead?.name?.split(" ")[0] || "tudo bem";
    const reason = lead?.reason || "avaliação/terapia";
    const origin = lead?.origin || "WhatsApp";

    const system = SYSTEM_PROMPT_AMANDA;
    const intro = personalizeIntro(origin);

    const user = `
Gere uma mensagem curta de follow-up para ${name}.
Contexto:
- Origem: ${origin}
- Motivo do contato: ${reason}
- Última interação: ${lead?.lastInteraction || "há alguns dias"}
Objetivo: reengajar e facilitar o agendamento.
Regras:
- Use exatamente 1 emoji 💚 (obrigatório).
- Ofereça no máximo 2 janelas de horário, se fizer sentido.
- Termine com: "Posso te ajudar a agendar agora?".
`;

    try {
        let resp;
        try {
            resp = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                temperature: 0.7,
                max_tokens: 140,
                messages: [
                    { role: "system", content: system },
                    { role: "user", content: intro + user },
                ],
            });
        } catch {
            resp = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                temperature: 0.7,
                max_tokens: 140,
                messages: [
                    { role: "system", content: system },
                    { role: "user", content: intro + user },
                ],
            });
        }

        const text = resp.choices?.[0]?.message?.content?.trim();
        const out = text || `Oi ${name}, tudo bem? Podemos retomar sobre ${reason}. Temos horários flexíveis. Posso te ajudar a agendar agora? 💚`;
        return out.includes("💚") ? out : `${out} 💚`;
    } catch {
        return `Oi ${name}, tudo bem? Passando para saber se posso te ajudar com ${reason}. Temos horários flexíveis nesta semana. Posso te ajudar a agendar agora? 💚`;
    }
}

/* =========================================================================
   FUNÇÕES DE MÍDIA (mantidas para compatibilidade)
   ========================================================================= */
export async function transcribeWaAudioFromGraph({ mediaUrl, fileName = "audio.ogg" } = {}) {
    try {
        const { data } = await axios.get(mediaUrl, {
            responseType: "arraybuffer",
            timeout: 20000,
        });
        const buffer = Buffer.from(data);

        const stream = Readable.from(buffer);
        stream.path = fileName;

        const resp = await openai.audio.transcriptions.create({
            file: stream,
            model: "whisper-1",
            language: "pt",
            temperature: 0.2,
        });

        return (resp?.text || "").trim();
    } catch (e) {
        console.error("❌ transcribeWaAudioFromGraph:", e?.message || e);
        return "";
    }
}

export async function describeWaImageFromGraph({ imageUrl, caption = "" } = {}) {
    try {
        const resp = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            temperature: 0.4,
            max_tokens: 160,
            messages: [
                {
                    role: "system",
                    content: "Você é a Amanda 💚, assistente da Clínica Fono Inova. Descreva brevemente a imagem em 1–2 frases, sem inventar, em pt-BR. Se não for possível entender, diga que verificará.",
                },
                {
                    role: "user",
                    content: [
                        { type: "text", text: `Legenda do cliente: ${caption || "(sem legenda)"}` },
                        { type: "image_url", image_url: { url: imageUrl } },
                    ],
                },
            ],
        });

        let out = (resp.choices?.[0]?.message?.content || "").trim();
        out = stripLinks(out);
        out = clampTo1to3Sentences(out);
        return out;
    } catch (e) {
        console.error("❌ describeWaImageFromGraph:", e?.message || e);
        return "";
    }
}

export { CLINIC_ADDRESS, POLICY_RULES, SYSTEM_PROMPT_AMANDA };
