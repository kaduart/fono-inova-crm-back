// utils/redisLock.js
import { getRedis } from '../services/redisClient.js';

const redis = getRedis();

const DEFAULT_TTL = 30; // segundos

/**
 * Adquire um lock distribuído no Redis
 * 
 * @param {string} resource - Nome do recurso (ex: appointment:123)
 * @param {number} ttl - Tempo de vida em segundos
 * @returns {Promise<string|null>} - Token do lock ou null se falhar
 */
export async function acquireLock(resource, ttl = DEFAULT_TTL) {
  const token = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const key = `lock:${resource}`;
  
  // NX = só seta se não existir, EX = com TTL
  const result = await redis.set(key, token, 'NX', 'EX', ttl);
  
  if (result === 'OK') {
    console.log(`[RedisLock] ✅ Lock adquirido: ${resource}`);
    return token;
  }
  
  console.log(`[RedisLock] ❌ Lock ocupado: ${resource}`);
  return null;
}

/**
 * Libera um lock
 * 
 * @param {string} resource - Nome do recurso
 * @param {string} token - Token do lock
 */
export async function releaseLock(resource, token) {
  const key = `lock:${resource}`;
  
  // Só libera se for o dono do lock (previne race condition na liberação)
  const currentToken = await redis.get(key);
  
  if (currentToken === token) {
    await redis.del(key);
    console.log(`[RedisLock] 🔓 Lock liberado: ${resource}`);
    return true;
  }
  
  console.log(`[RedisLock] ⚠️ Token não match (lock expirou?): ${resource}`);
  return false;
}

/**
 * Extende o TTL de um lock
 * 
 * @param {string} resource - Nome do recurso
 * @param {string} token - Token do lock
 * @param {number} ttl - Novo TTL
 */
export async function extendLock(resource, token, ttl = DEFAULT_TTL) {
  const key = `lock:${resource}`;
  
  const currentToken = await redis.get(key);
  
  if (currentToken === token) {
    await redis.expire(key, ttl);
    return true;
  }
  
  return false;
}

/**
 * Wrapper para executar função com lock
 * 
 * @param {string} resource - Recurso a bloquear
 * @param {Function} fn - Função a executar
 * @param {Object} options - Opções
 */
export async function withLock(resource, fn, options = {}) {
  const { ttl = DEFAULT_TTL, retries = 0, retryDelay = 100 } = options;
  
  let token = null;
  let attempts = 0;
  
  // Tenta adquirir lock
  while (attempts <= retries) {
    token = await acquireLock(resource, ttl);
    if (token) break;
    
    attempts++;
    if (attempts <= retries) {
      await new Promise(r => setTimeout(r, retryDelay));
    }
  }
  
  if (!token) {
    throw new Error(`LOCK_ACQUISITION_FAILED: ${resource}`);
  }
  
  try {
    return await fn();
  } finally {
    await releaseLock(resource, token);
  }
}
