/**
 * 🗄️ ContextCache - Cache de contexto enriquecido para SmartFallback
 * Cache Redis 5min para evitar queries repetidas no MongoDB
 */

import { getRedis } from '../redisClient.js';
import Logger from '../utils/Logger.js';

const logger = new Logger('ContextCache');
const CACHE_TTL = 300; // 5 minutos
const PREFIX = 'ctx:';

/**
 * Busca contexto enriquecido com cache
 */
export async function getEnrichedContext(leadId, fetchFn) {
    const redis = getRedis();
    const cacheKey = `${PREFIX}${leadId}`;
    
    try {
        // 1. Tenta buscar do cache
        const cached = await redis.get(cacheKey);
        if (cached) {
            logger.debug('CONTEXT_CACHE_HIT', { leadId });
            return JSON.parse(cached);
        }
        
        // 2. Cache miss - busca do banco
        logger.debug('CONTEXT_CACHE_MISS', { leadId });
        const data = await fetchFn();
        
        // 3. Salva no cache (fire and forget, não bloqueia)
        redis.set(cacheKey, JSON.stringify(data), { EX: CACHE_TTL }).catch(err => {
            logger.warn('CONTEXT_CACHE_SET_ERROR', { leadId, error: err.message });
        });
        
        return data;
        
    } catch (error) {
        logger.error('CONTEXT_CACHE_ERROR', { leadId, error: error.message });
        // Fallback: busca direto sem cache
        return await fetchFn();
    }
}

/**
 * Invalida cache do lead (quando dados mudam)
 */
export async function invalidateContextCache(leadId) {
    const redis = getRedis();
    const cacheKey = `${PREFIX}${leadId}`;
    
    try {
        await redis.del(cacheKey);
        logger.debug('CONTEXT_CACHE_INVALIDATED', { leadId });
    } catch (error) {
        logger.warn('CONTEXT_CACHE_INVALIDATE_ERROR', { leadId, error: error.message });
    }
}

/**
 * Stats do cache (para monitoramento)
 */
export async function getCacheStats() {
    const redis = getRedis();
    try {
        const keys = await redis.keys(`${PREFIX}*`);
        return {
            cachedContexts: keys.length,
            ttl: CACHE_TTL,
            prefix: PREFIX
        };
    } catch {
        return { cachedContexts: 0, ttl: CACHE_TTL };
    }
}

/**
 * 🔧 Funções simples de get/set para uso direto (compatibilidade com WhatsAppOrchestrator)
 */
const cacheStore = new Map(); // Cache em memória (fallback se Redis falhar)

export async function getCachedContext(leadId) {
    const redis = getRedis();
    const cacheKey = `${PREFIX}${leadId}`;
    
    try {
        // Tenta Redis primeiro
        const cached = await redis.get(cacheKey);
        if (cached) {
            return JSON.parse(cached);
        }
        // Fallback: memória local
        return cacheStore.get(leadId) || null;
    } catch (error) {
        // Se Redis falhar, usa memória
        return cacheStore.get(leadId) || null;
    }
}

export async function setCachedContext(leadId, context) {
    const redis = getRedis();
    const cacheKey = `${PREFIX}${leadId}`;
    
    try {
        // Salva no Redis
        await redis.set(cacheKey, JSON.stringify(context), { EX: CACHE_TTL });
    } catch (error) {
        logger.warn('REDIS_CACHE_ERROR', { leadId, error: error.message });
    }
    
    // Sempre salva em memória como backup
    cacheStore.set(leadId, context);
}

export default { getEnrichedContext, invalidateContextCache, getCacheStats, getCachedContext, setCachedContext };
