/**
 * 🧠 Extractor Semântico - Fallback inteligente quando regex falham
 * Usa Groq (grátis) como primário, OpenAI como fallback
 */

import { callAI } from "../IA/Aiproviderservice.js";
import Logger from "../utils/Logger.js";

const logger = new Logger("SemanticExtractor");

/**
 * Extrai dados usando IA quando regex não conseguem
 * @param {string} text - Texto do usuário
 * @param {string} awaitingField - Campo esperado (age, complaint, period, etc)
 * @param {object} context - Contexto da conversa
 */
export async function smartExtract(text, awaitingField, context = {}) {
    // Se não há campo esperado, não faz extração semântica
    if (!awaitingField) return null;

    const startTime = Date.now();

    try {
        const prompt = buildExtractionPrompt(text, awaitingField, context);
        
        const response = await callAI({
            systemPrompt: "Você é um extrator de dados preciso. Responda APENAS em JSON.",
            messages: [{ role: "user", content: prompt }],
            maxTokens: 100,
            temperature: 0.1, // Baixíssima criatividade = mais precisão
            usePremiumModel: false // Groq 8b é suficiente para isso
        });

        if (!response) return null;

        // Parse do JSON
        const result = parseJSONSafe(response);
        
        logger.debug("SEMANTIC_EXTRACTION", {
            field: awaitingField,
            input: text,
            result,
            duration: Date.now() - startTime
        });

        return validateAndTransform(result, awaitingField);

    } catch (err) {
        logger.warn("Semantic extraction failed:", err.message);
        return null;
    }
}

/**
 * Monta prompt específico para cada tipo de campo
 */
function buildExtractionPrompt(text, field, context) {
    const baseContext = context.lastAmandaMessage 
        ? `Amanda perguntou: "${context.lastAmandaMessage}"`
        : "Contexto: conversa de agendamento médico";

    const prompts = {
        age: `${baseContext}
Usuário respondeu: "${text}"

Extraia a IDADE em anos. Responda em JSON:
{"age": número, "confidence": 0-1}

Exemplos:
- "5" → {"age": 5, "confidence": 0.9}
- "cinco anos" → {"age": 5, "confidence": 0.95}
- "ele tem 3 aninhos" → {"age": 3, "confidence": 0.9}
- "fez 2 agora em janeiro" → {"age": 2, "confidence": 0.85}
- "bebe de 8 meses" → {"age": 0, "months": 8, "confidence": 0.9}
- "não sei" → {"age": null, "confidence": 0}`,

        complaint: `${baseContext}
Usuário respondeu: "${text}"

Extraia a QUEIXA principal (motivo da consulta). Responda em JSON:
{"complaint": "descrição curta", "confidence": 0-1}

Regras:
- Resuma em 2-5 palavras
- Foco no sintoma/condição
- Ignore cumprimentos

Exemplos:
- "ele fala poucas palavras" → {"complaint": "atraso na fala", "confidence": 0.95}
- "tem dificuldade para ler" → {"complaint": "dislexia/dificuldade leitura", "confidence": 0.9}
- "gagueira" → {"complaint": "gagueira", "confidence": 0.95}
- "não sei, vou pensar" → {"complaint": null, "confidence": 0}`,

        period: `${baseContext}
Usuário respondeu: "${text}"

Extraia o PERÍODO do dia. Responda em JSON:
{"period": "manha|tarde|noite", "confidence": 0-1}

Mapeamento:
- "manhã", "cedo", "pela manhã", "antes do almoço", "de manhã cedo" → "manha"
- "tarde", "depois do almoço", "pela tarde" → "tarde"
- "noite", "fim de tarde", "depois das 18h" → "noite"

Exemplos:
- "de manhã cedo" → {"period": "manha", "confidence": 0.95}
- "qualquer horário" → {"period": null, "confidence": 0.5}
- "depois do almoço" → {"period": "tarde", "confidence": 0.9}`,

        therapy: `${baseContext}
Usuário respondeu: "${text}"

Extraia a ESPECIALIDADE médica. Responda em JSON:
{"therapy": "fonoaudiologia|psicologia|terapia_ocupacional|fisioterapia|neuropsicologia|musicoterapia|psicomotricidade", "confidence": 0-1}

Exemplos:
- "preciso de fono" → {"therapy": "fonoaudiologia", "confidence": 0.95}
- "psicólogo" → {"therapy": "psicologia", "confidence": 0.95}
- "terapia ocupacional" → {"therapy": "terapia_ocupacional", "confidence": 0.95}
- "não sei qual preciso" → {"therapy": null, "confidence": 0}`
    };

    return prompts[field] || `${baseContext}\nUsuário respondeu: "${text}"\n\nExtraia o campo "${field}" em JSON.`;
}

/**
 * Faz parse seguro de JSON
 */
function parseJSONSafe(text) {
    try {
        // Tenta extrair JSON de markdown ```json ... ```
 const jsonMatch = text.match(/```(?:json)?\s*({[\s\S]*?})\s*```/);
        if (jsonMatch) return JSON.parse(jsonMatch[1]);
        
        // Tenta parse direto
        return JSON.parse(text);
    } catch {
        // Tenta extrair objeto manualmente
        const match = text.match(/{[\s\S]*?}/);
        if (match) {
            try {
                return JSON.parse(match[0]);
            } catch {
                return null;
            }
        }
        return null;
    }
}

/**
 * Valida e transforma o resultado da IA
 */
function validateAndTransform(result, field) {
    if (!result || result.confidence < 0.7) return null;

    switch (field) {
        case "age":
            if (result.age && result.age > 0 && result.age < 120) {
                return { age: result.age, months: result.months || null };
            }
            return null;

        case "complaint":
            if (result.complaint && result.complaint.length > 3) {
                return { complaint: result.complaint.substring(0, 100) };
            }
            return null;

        case "period":
            if (["manha", "tarde", "noite"].includes(result.period)) {
                return { period: result.period };
            }
            return null;

        case "therapy":
            const validTherapies = ["fonoaudiologia", "psicologia", "terapia_ocupacional", "fisioterapia", "neuropsicologia", "musicoterapia", "psicomotricidade"];
            if (validTherapies.includes(result.therapy)) {
                return { therapy: result.therapy };
            }
            return null;

        default:
            return result;
    }
}

export default { smartExtract };
