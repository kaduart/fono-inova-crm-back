// utils/aiAutoReply.js
import { redisConnection as redis } from "../config/redisConnection.js";

// evita responder 2x para o mesmo número em poucos segundos (latência/socket/etc.)
export async function aiShouldReply(phone, ttlSeconds = 20) {
    if (!phone) return false;
    const key = `ai:auto:${phone}`;
    // NX = só seta se não existir | EX = expira em ttlSeconds
    const ok = await redis.set(key, "1", "NX", "EX", ttlSeconds);
    return !!ok;
}

// checa se o texto é "placeholder" de mídia (não devemos responder)
export function isPlaceholderText(txt) {
    return /^\s*\[(?:AUDIO|IMAGE|VIDEO|DOCUMENT|STICKER)\]\s*$/i.test(String(txt || ""));
}
