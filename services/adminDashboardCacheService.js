/**
 * 🚀 Admin Dashboard Cache Service - Event-Driven
 * 
 * Cacheia dados pesados do Admin Dashboard para carregamento instantâneo
 * Invalidação via eventos quando dados mudam
 */

import redisClient from './redisClient.js';

const CACHE_TTL = 300; // 5 minutos
const CACHE_PREFIX = 'admin:dashboard:';

class AdminDashboardCacheService {
  
  /**
   * Busca do cache ou executa função e cacheia resultado
   */
  async getOrSet(key, fetchFn, ttl = CACHE_TTL) {
    try {
      // Tenta buscar do cache
      const cached = await this.get(key);
      if (cached) {
        console.log(`[DashboardCache] Cache HIT: ${key}`);
        return JSON.parse(cached);
      }
      
      // Miss - executa função
      console.log(`[DashboardCache] Cache MISS: ${key}`);
      const data = await fetchFn();
      
      // Salva no cache (não bloqueia resposta)
      this.set(key, data, ttl).catch(err => 
        console.error(`[DashboardCache] Erro ao salvar cache: ${err.message}`)
      );
      
      return data;
    } catch (error) {
      console.error(`[DashboardCache] Erro: ${error.message}`);
      // Fallback: executa sem cache
      return fetchFn();
    }
  }
  
  /**
   * Busca valor do cache
   */
  async get(key) {
    if (!redisClient.isReady) return null;
    return redisClient.get(`${CACHE_PREFIX}${key}`);
  }
  
  /**
   * Salva no cache
   */
  async set(key, data, ttl = CACHE_TTL) {
    if (!redisClient.isReady) return;
    await redisClient.setEx(
      `${CACHE_PREFIX}${key}`,
      ttl,
      JSON.stringify(data)
    );
  }
  
  /**
   * Invalida cache específico
   */
  async invalidate(key) {
    if (!redisClient.isReady) return;
    await redisClient.del(`${CACHE_PREFIX}${key}`);
    console.log(`[DashboardCache] Invalidado: ${key}`);
  }
  
  /**
   * Invalida todos os caches do dashboard
   */
  async invalidateAll() {
    if (!redisClient.isReady) return;
    const keys = await redisClient.keys(`${CACHE_PREFIX}*`);
    if (keys.length > 0) {
      await redisClient.del(keys);
      console.log(`[DashboardCache] Invalidados ${keys.length} caches`);
    }
  }
  
  /**
   * Cache keys específicas
   */
  keys = {
    payments: (filters) => `payments:${JSON.stringify(filters)}`,
    adminProfile: (userId) => `profile:${userId}`,
    dashboardOverview: () => 'overview',
    preAgendamentos: (limit) => `pre-agendamentos:${limit}`,
    convenioReceivables: (month, status) => `convenio:${month}:${status}`,
    dailyClosing: (date) => `daily-closing:${date}`
  };
}

// Singleton
export const dashboardCache = new AdminDashboardCacheService();

/**
 * 🎯 Event Handlers para invalidação automática
 * TODO: Implementar quando eventPublisher tiver subscribe
 */
export function setupDashboardCacheInvalidation() {
  console.log('[DashboardCache] Event handlers não implementados - aguardando eventPublisher.subscribe');
}

export default dashboardCache;
