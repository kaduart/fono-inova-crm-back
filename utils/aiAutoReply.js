// utils/aiAutoReply.js
import { redisConnection as redis } from "../config/redisConnection.js";

// ✅ CORREÇÃO: Adicionado 'messageId' nos parâmetros para evitar erro de referência
export async function aiShouldReply(phone, messageId, ttlSeconds = 3) {
    if (!phone) return false;

    // Se messageId existir, usa ele (melhor precisão). Se não, usa o telefone (evita spam geral).
    const suffix = messageId || phone;
    const key = `ai:msg:${suffix}`;

    // Tenta setar a chave. Se já existir (NX falhar), retorna null.
    const ok = await redis.set(key, "1", "NX", "EX", ttlSeconds);

    return !!ok; // Retorna true se puder responder, false se for duplicado
}

// checa se o texto é "placeholder" de mídia (não devemos responder)
export function isPlaceholderText(txt) {
    return /^\s*\[(?:AUDIO|IMAGE|VIDEO|DOCUMENT|STICKER)\]\s*$/i.test(String(txt || ""));
}