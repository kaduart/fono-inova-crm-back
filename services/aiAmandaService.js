import axios from "axios";
import OpenAI from "openai";
import { Readable } from "stream";
import { getMediaBuffer } from "./whatsappMediaService.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* =========================================================================
   🧠 AI AMANDA SERVICE — HELPERS (Limpeza 2024-2025)
   ========================================================================= 
   
   ⚠️ Lógica principal agora está no AmandaOrchestrator.js
   Este arquivo mantém apenas helpers utilitários para mídia e fallback.
*/

/**
 * 🔗 PROXY: Gera mensagem de follow-up (usado pelo followupController)
 * Mantido por compatibilidade, mas idealmente deveria mover para um Orchestrator de FollowUp.
 */
export async function generateFollowupMessage(lead) {
    // TODO: Migrar lógica real para FollowupOrchestrator se necessário
    // Por enquanto retorna null para não quebrar imports existentes
    console.warn("⚠️ generateFollowupMessage chamado em aiAmandaService (deprecated)");
    return null;
}

/**
 * 📦 PROXY: Gera resposta da Amanda (usado por rotas legadas)
 * Deprecated. Use AmandaOrchestrator.
 */
export async function generateAmandaReply({ userText, lead = {}, context = {} }) {
    console.warn("⚠️ generateAmandaReply chamado em aiAmandaService (DEPRECATED - use AmandaOrchestrator)");
    return null;
}

/* =========================================================================
   📞 FUNÇÕES DE MÍDIA E UTILITÁRIAS
   ========================================================================= */

/**
 * 👁️ Descreve imagem (Vision API)
 */
export async function describeWaImage({ mediaUrl, mimeType, mediaId }) {
    try {
        console.log(`👁️ Descrevendo imagem ${mediaId}...`);

        let finalBuffer, finalMime;

        if (mediaId && !mediaUrl) {
            // console.log("🔍 [describeWaImage] Usando mediaId para buscar mídia");
            const mediaBuffer = await getMediaBuffer(mediaId);
            if (!mediaBuffer) throw new Error("Não foi possível obter o buffer da mídia");
            finalBuffer = mediaBuffer.buffer || mediaBuffer;
            finalMime = mediaBuffer.mimeType || mimeType;
        } else if (mediaUrl) {
            // console.log("🔍 [describeWaImage] Usando mediaUrl para download");
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

        // Converte para base64
        const base64Image = processedBuffer.toString('base64');

        // Chama GPT-4 Vision
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini", // ou gpt-4-turbo
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "Descreva esta imagem brevemente (1 frase) para um assistente de clínica. Foque no conteúdo relevante (ex: criança, exame, documento)." },
                        {
                            type: "image_url",
                            image_url: {
                                "url": `data:${finalMime};base64,${base64Image}`
                            },
                        },
                    ],
                },
            ],
            max_tokens: 150,
        });

        return response.choices[0].message.content || "(Sem descrição)";
    } catch (err) {
        console.error("❌ Erro ao descrever imagem:", err.message);
        return "(Imagem não pôde ser descrita)";
    }
}

/**
 * 👂 Transcreve áudio (Whisper API)
 */
export async function transcribeWaAudio({ mediaUrl, mimeType, mediaId }) {
    try {
        console.log(`👂 Transcrevendo áudio ${mediaId}...`);

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

        // Cria stream legível para o OpenAI (necessário para file upload)
        const stream = Readable.from(finalBuffer);
        // Hack: Adiciona path para o axios/openai form-data reconhecer extensão
        stream.path = `audio.ogg`;

        // Chama Whisper API
        const response = await openai.audio.transcriptions.create({
            file: stream,
            model: "whisper-1",
        });

        return response.text || "";
    } catch (err) {
        console.error("❌ Erro ao transcrever áudio:", err.message);
        return "";
    }
}

/**
 * 🤖 Fallback para OpenAI (usado pelo AmandaOrchestrator quando Claude falha)
 */
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
