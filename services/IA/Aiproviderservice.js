// services/aiProviderService.js - Provider unificado (Groq → OpenAI)
import Groq from "groq-sdk";
import OpenAI from "openai";
import "dotenv/config";

// ============================================================================
// 🔧 CONFIGURAÇÃO DOS PROVIDERS
// ============================================================================

const groq = process.env.GROQ_API_KEY
    ? new Groq({ apiKey: process.env.GROQ_API_KEY })
    : null;

const openai = process.env.OPENAI_API_KEY
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

export async function callAI({
    systemPrompt,
    messages,
    maxTokens = 300,
    temperature = 0.7,
    usePremiumModel = false
}) {
    const errors = [];

    // 1️⃣ GROQ (primário - grátis)
    if (groq) {
        try {
            const response = await callGroq({ systemPrompt, messages, maxTokens, temperature, usePremiumModel });
            if (response) {
                console.log("✅ [AI] Resposta via Groq");
                return response;
            }
        } catch (err) {
            errors.push(`Groq: ${err.message}`);
            console.warn("⚠️ [AI] Groq falhou:", err.message);
        }
    }

    // 2️⃣ OPENAI (fallback)
    if (openai) {
        try {
            const response = await callOpenAI({ systemPrompt, messages, maxTokens, temperature });
            if (response) {
                console.log("✅ [AI] Resposta via OpenAI (fallback)");
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