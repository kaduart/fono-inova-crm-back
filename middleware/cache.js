/**
 * 🚀 Middleware de Cache Redis
 * 
 * Fornece camada de cache para endpoints frequentemente acessados,
 * reduzindo carga no MongoDB e melhorando tempo de resposta.
 */

import { createClient } from 'redis';

// Configuração do cliente Redis
const redisClient = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    socket: {
        reconnectStrategy: (retries) => {
            if (retries > 10) {
                console.error('❌ Redis: Máximo de reconexões atingido');
                return new Error('Redis connection failed');
            }
            return Math.min(retries * 100, 3000);
        }
    }
});

redisClient.on('error', (err) => {
    console.error('⚠️ Redis Client Error:', err.message);
});

redisClient.on('connect', () => {
    console.log('✅ Redis conectado');
});

// Conectar apenas se não estiver conectado
if (!redisClient.isOpen) {
    redisClient.connect().catch(console.error);
}

/**
 * TTL padrão por tipo de dados (em segundos)
 */
const DEFAULT_TTL = {
    STATS: 300,        // 5 minutos - estatísticas do dashboard
    LIST: 120,         // 2 minutos - listagens
    DETAIL: 600,       // 10 minutos - detalhes individuais
    ANALYTICS: 900,    // 15 minutos - dados GA4
    USER: 1800,        // 30 minutos - dados de usuário
    STATIC: 3600       // 1 hora - dados que raramente mudam
};

/**
 * Middleware de cache para rotas Express
 * @param {string} keyPrefix - Prefixo para a chave de cache
 * @param {number} ttl - Tempo de vida em segundos
 * @param {Function} keyGenerator - Função para gerar chave personalizada
 */
export const cacheMiddleware = (keyPrefix, ttl = DEFAULT_TTL.LIST, keyGenerator = null) => {
    return async (req, res, next) => {
        // Skip cache em desenvolvimento se solicitado
        if (process.env.NODE_ENV === 'development' && req.headers['x-no-cache']) {
            return next();
        }

        try {
            // Verificar se Redis está conectado
            if (!redisClient.isReady) {
                return next();
            }

            // Gerar chave de cache
            const cacheKey = keyGenerator 
                ? keyGenerator(req)
                : `${keyPrefix}:${req.originalUrl}:${JSON.stringify(req.query)}:${JSON.stringify(req.params)}`;

            // Tentar recuperar do cache
            const cached = await redisClient.get(cacheKey);
            
            if (cached) {
                const data = JSON.parse(cached);
                res.setHeader('X-Cache', 'HIT');
                res.setHeader('X-Cache-TTL', ttl);
                return res.json(data);
            }

            // Sobrescrever res.json para armazenar no cache
            const originalJson = res.json.bind(res);
            res.json = (data) => {
                // Apenas cache se resposta for bem-sucedida
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    redisClient.setEx(cacheKey, ttl, JSON.stringify(data))
                        .catch(err => console.error('Erro ao salvar no cache:', err));
                }
                res.setHeader('X-Cache', 'MISS');
                return originalJson(data);
            };

            next();
        } catch (error) {
            console.error('Erro no middleware de cache:', error);
            next();
        }
    };
};

/**
 * Cache para funções assíncronas
 * @param {Function} fn - Função a ser cacheada
 * @param {string} key - Chave de cache
 * @param {number} ttl - Tempo de vida
 */
export const cacheFunction = async (fn, key, ttl = DEFAULT_TTL.STATS) => {
    try {
        if (!redisClient.isReady) {
            return await fn();
        }

        const cached = await redisClient.get(key);
        if (cached) {
            return JSON.parse(cached);
        }

        const result = await fn();
        await redisClient.setEx(key, ttl, JSON.stringify(result));
        return result;
    } catch (error) {
        console.error('Erro no cacheFunction:', error);
        return await fn();
    }
};

/**
 * Invalidar cache por padrão de chave
 * @param {string} pattern - Padrão de chave (ex: 'patients:*')
 */
export const invalidateCache = async (pattern) => {
    try {
        if (!redisClient.isReady) return;

        const keys = await redisClient.keys(pattern);
        if (keys.length > 0) {
            await redisClient.del(keys);
            console.log(`🗑️  Cache invalidado: ${pattern} (${keys.length} chaves)`);
        }
    } catch (error) {
        console.error('Erro ao invalidar cache:', error);
    }
};

/**
 * Limpar todo o cache
 */
export const clearAllCache = async () => {
    try {
        if (!redisClient.isReady) return;
        await redisClient.flushAll();
        console.log('🗑️  Todo o cache foi limpo');
    } catch (error) {
        console.error('Erro ao limpar cache:', error);
    }
};

/**
 * Obter estatísticas do cache
 */
export const getCacheStats = async () => {
    try {
        if (!redisClient.isReady) {
            return { error: 'Redis não conectado' };
        }

        const info = await redisClient.info('memory');
        const keys = await redisClient.keys('*');
        
        return {
            connected: true,
            keysCount: keys.length,
            memoryInfo: info,
            keys: keys.slice(0, 50) // Primeiras 50 chaves
        };
    } catch (error) {
        return { error: error.message };
    }
};

// Exportar cliente para uso direto
export { redisClient, DEFAULT_TTL };

// Exportar middlewares pré-configurados
export const cacheStats = (ttl = DEFAULT_TTL.STATS) => cacheMiddleware('stats', ttl);
export const cacheList = (ttl = DEFAULT_TTL.LIST) => cacheMiddleware('list', ttl);
export const cacheDetail = (ttl = DEFAULT_TTL.DETAIL) => cacheMiddleware('detail', ttl);
export const cacheAnalytics = (ttl = DEFAULT_TTL.ANALYTICS) => cacheMiddleware('analytics', ttl);
