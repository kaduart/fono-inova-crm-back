/**
 * ⚡ Context Cache - Performance
 * Cache em memória para evitar queries repetidas no MongoDB
 * TTL: 30 segundos
 */

const cache = new Map();
const TTL = 30 * 1000; // 30 segundos

export function getCachedContext(leadId) {
    const key = `lead:${leadId}`;
    const entry = cache.get(key);
    
    if (!entry) return null;
    
    // Verifica se expirou
    if (Date.now() - entry.timestamp > TTL) {
        cache.delete(key);
        return null;
    }
    
    return entry.data;
}

export function setCachedContext(leadId, data) {
    const key = `lead:${leadId}`;
    cache.set(key, {
        data,
        timestamp: Date.now()
    });
}

export function invalidateCache(leadId) {
    const key = `lead:${leadId}`;
    cache.delete(key);
}

// Limpa entradas expiradas a cada 5 minutos
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of cache.entries()) {
        if (now - entry.timestamp > TTL) {
            cache.delete(key);
        }
    }
}, 5 * 60 * 1000);

export default { getCachedContext, setCachedContext, invalidateCache };
