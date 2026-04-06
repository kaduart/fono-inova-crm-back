// services/aiProviderService.js - Provider unificado (Groq → OpenAI)
import Groq from "groq-sdk";
import OpenAI from "openai";
import "dotenv/config";

// ============================================================================
// 🚨 VALIDAÇÃO CRÍTICA DE API KEY
// ============================================================================

function validateApiKey() {
    const key = process.env.OPENAI_API_KEY;
    
    if (!key) {
        console.error("🚨 [CRÍTICO] OPENAI_API_KEY não definida!");
        return false;
    }
    
    if (key.includes("test") || key.includes("dummy") || key.includes("fake")) {
        console.error("🚨 [CRÍTICO] OPENAI_API_KEY contém valor de teste! Use sk-prod- ou sk-live-");
        console.error("   Valor atual:", key.substring(0, 15) + "...");
        return false;
    }
    
    if (!key.startsWith("sk-")) {
        console.error("🚨 [CRÍTICO] OPENAI_API_KEY formato inválido! Deve começar com sk-");
        return false;
    }
    
    return true;
}

// Validação no startup (só loga, não bloqueia para não quebrar dev)
const isApiKeyValid = validateApiKey();

// ============================================================================
// 🔧 CONFIGURAÇÃO DOS PROVIDERS
// ============================================================================

const groq = process.env.GROQ_API_KEY
    ? new Groq({ apiKey: process.env.GROQ_API_KEY })
    : null;

const openai = process.env.OPENAI_API_KEY && isApiKeyValid
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null;

// Modelos por provider
const MODELS = {
    groq: "llama-3.1-8b-instant",
    groqPremium: "llama-3.1-70b-versatile",
    openai: "gpt-4o-mini"
};

// ============================================================================
// 🚀 FUNÇÃO PRINCIPAL - CHAMADA COM FALLBACK AUTOMÁTICO
// ============================================================================

// 🆕 Helper sleep
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 🆕 Groq com timeout de 8s
async function callGroqWithTimeout(params, timeoutMs = 8000) {
    return Promise.race([
        callGroq(params),
        new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Groq timeout')), timeoutMs)
        )
    ]);
}

export async function callAI({
    systemPrompt,
    messages,
    maxTokens = 300,
    temperature = 0.7,
    usePremiumModel = false
}) {
    const errors = [];
    const params = { systemPrompt, messages, maxTokens, temperature, usePremiumModel };

    // 1️⃣ GROQ (primário - grátis) com retry 1x
    if (groq) {
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const response = await callGroqWithTimeout(params, 8000);
                if (response) {
                    console.log("✅ [AI] Resposta via Groq");
                    return response;
                }
            } catch (err) {
                console.warn(`⚠️ [LLM] Groq falhou (tentativa ${attempt}):`, err.message);
                errors.push(`Groq (tentativa ${attempt}): ${err.message}`);
                
                if (attempt < 2) {
                    console.log("[LLM] Aguardando 1.5s antes de retry...");
                    await sleep(1500);
                }
            }
        }
        console.warn("[LLM] Groq indisponível após 2 tentativas, usando OpenAI fallback");
    }

    // 2️⃣ OPENAI (fallback)
    if (openai) {
        try {
            const response = await callOpenAI({ systemPrompt, messages, maxTokens, temperature });
            if (response) {
                console.log("✅ [LLM] OpenAI respondeu como fallback");
                return response;
            }
        } catch (err) {
            errors.push(`OpenAI: ${err.message}`);
            console.warn("⚠️ [AI] OpenAI falhou:", err.message);
        }
    }

    // 3️⃣ Todos falharam
    console.error("❌ [AI] Todos os providers falharam:", errors);
    throw new Error(`Todos os providers falharam: ${errors.join("; ")}`);
}

// ============================================================================
// 🟢 GROQ (Llama 3.1) - PRIMÁRIO
// ============================================================================

async function callGroq({ systemPrompt, messages, maxTokens, temperature, usePremiumModel }) {
    const model = usePremiumModel ? MODELS.groqPremium : MODELS.groq;

    const groqMessages = [
        { role: "system", content: systemPrompt },
        ...normalizeMessages(messages)
    ];

    const response = await groq.chat.completions.create({
        model,
        messages: groqMessages,
        max_tokens: maxTokens,
        temperature,
    });

    return response.choices[0]?.message?.content?.trim() || null;
}

// ============================================================================
// 🔵 OPENAI - FALLBACK
// ============================================================================

async function callOpenAI({ systemPrompt, messages, maxTokens, temperature }) {
    const openaiMessages = [
        { role: "system", content: systemPrompt },
        ...normalizeMessages(messages)
    ];

    const response = await openai.chat.completions.create({
        model: MODELS.openai,
        messages: openaiMessages,
        max_tokens: maxTokens,
        temperature,
    });

    return response.choices[0]?.message?.content?.trim() || null;
}

// ============================================================================
// 🔧 HELPERS
// ============================================================================

function normalizeMessages(messages) {
    return messages.map(msg => ({
        role: msg.role,
        content: typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content)
    }));
}

// ============================================================================
// 📊 STATUS DOS PROVIDERS
// ============================================================================

export function getAIStatus() {
    return {
        groq: {
            configured: !!groq,
            model: MODELS.groq,
            tier: "free",
            limits: "6K req/dia"
        },
        openai: {
            configured: !!openai,
            model: MODELS.openai,
            role: "fallback"
        },
        primaryProvider: groq ? "groq" : (openai ? "openai" : "none")
    };
}

export default callAI;