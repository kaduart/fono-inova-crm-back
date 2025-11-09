// utils/aiAutoReply.js
import { redisConnection as redis } from "../config/redisConnection.js";

// evita responder 2x para o mesmo número em poucos segundos (latência/socket/etc.)
export async function aiShouldReply(phone, ttlSeconds = 3) { // ✅ Era 20, agora é 3
    if (!phone) return false;
    const key = `ai:auto:${phone}`;
    const ok = await redis.set(key, "1", "NX", "EX", ttlSeconds);
    return !!ok;
}

// checa se o texto é "placeholder" de mídia (não devemos responder)
export function isPlaceholderText(txt) {
    return /^\s*\[(?:AUDIO|IMAGE|VIDEO|DOCUMENT|STICKER)\]\s*$/i.test(String(txt || ""));
}
