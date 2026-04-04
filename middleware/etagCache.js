/**
 * 🏷️ ETag Cache Middleware
 * 
 * Gera ETag baseado no conteúdo e retorna 304 quando dados não mudaram
 * Reduz drasticamente o tempo de reload da página
 */

import crypto from 'crypto';
import redisClient from '../services/redisClient.js';

const CACHE_PREFIX = 'etag:';

/**
 * Gera ETag a partir dos dados
 */
export function generateETag(data) {
  const hash = crypto.createHash('md5');
  hash.update(JSON.stringify(data));
  return hash.digest('hex');
}

/**
 * Middleware que adiciona ETag e verifica If-None-Match
 */
export function etagMiddleware(options = {}) {
  const { ttl = 60, keyGenerator } = options;
  
  return async (req, res, next) => {
    // Só aplica para GET
    if (req.method !== 'GET') {
      return next();
    }
    
    const cacheKey = keyGenerator 
      ? `${CACHE_PREFIX}${keyGenerator(req)}`
      : `${CACHE_PREFIX}${req.originalUrl}`;
    
    // Verifica ETag do cliente
    const clientETag = req.headers['if-none-match'];
    
    try {
      // Busca ETag do cache
      const cachedETag = redisClient.isReady 
        ? await redisClient.get(cacheKey)
        : null;
      
      // Se ETag do cliente = ETag do cache, retorna 304
      if (clientETag && cachedETag && clientETag === cachedETag) {
        console.log(`[ETag] 304 Not Modified: ${req.originalUrl}`);
        return res.status(304).end();
      }
      
      // Intercepta resposta para adicionar ETag
      const originalJson = res.json.bind(res);
      
      res.json = (data) => {
        // Gera ETag dos dados
        const etag = generateETag(data);
        
        // Salva no cache
        if (redisClient.isReady) {
          redisClient.setEx(cacheKey, ttl, etag).catch(console.error);
        }
        
        // Adiciona headers
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', `private, max-age=${ttl}`);
        
        return originalJson(data);
      };
      
      next();
    } catch (error) {
      console.error('[ETag] Erro:', error);
      next();
    }
  };
}

/**
 * Invalida ETag de uma rota específica
 */
export async function invalidateETag(route) {
  if (!redisClient.isReady) return;
  const keys = await redisClient.keys(`${CACHE_PREFIX}${route}*`);
  if (keys.length > 0) {
    await redisClient.del(keys);
    console.log(`[ETag] Invalidados ${keys.length} caches para ${route}`);
  }
}

export default { etagMiddleware, invalidateETag, generateETag };
