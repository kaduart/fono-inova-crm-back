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
    constructor() {
      this.revalidating = new Set(); // 🔥 Anti-stampede lock
    }
  /**
   * Busca do cache ou executa função e cacheia resultado
   * 
   * 🔥 OTIMIZAÇÃO: Stale-while-revalidate
   * - Se tem cache (mesmo velho), retorna imediatamente
   - Rebuild async em background
   * - Usuário nunca espera
   */
  async getOrSet(key, fetchFn, ttl = CACHE_TTL) {
    try {
      // Tenta buscar do cache
      const cached = await this.get(key);
      
      if (cached) {
        const data = JSON.parse(cached);
        console.log(`[DashboardCache] Cache HIT: ${key}`);
        
        // 🔥 VERIFICA SE PRECISA REBUILD (TTL/2 = 2.5min)
        const shouldRebuild = !data._cachedAt || 
          (Date.now() - new Date(data._cachedAt).getTime() > (ttl * 1000 / 2));
        
        if (shouldRebuild && !this.revalidating.has(key)) {
          // 🔥 ANTI-STAMPEDE: Só 1 rebuild por vez por chave
          this.revalidating.add(key);
          
          // REBUILD ASSÍNCRONO (não bloqueia)
          setImmediate(async () => {
            try {
              console.log(`[DashboardCache] 🔄 Rebuild async: ${key}`);
              const fresh = await fetchFn();
              fresh._cachedAt = new Date().toISOString();
              await this.set(key, fresh, ttl);
              console.log(`[DashboardCache] ✅ Rebuild done: ${key}`);
            } catch (err) {
              console.error(`[DashboardCache] ⚠️ Rebuild erro: ${err.message}`);
            } finally {
              this.revalidating.delete(key);
            }
          });
        }
        
        return data;
      }
      
      // 🔥 MISS: Executa mas com timeout de segurança
      console.log(`[DashboardCache] Cache MISS: ${key}`);
      const data = await this._fetchWithTimeout(fetchFn, 5000); // max 5s
      data._cachedAt = new Date().toISOString();
      
      // Salva no cache (não bloqueia)
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
   * 🔥 Fetch com timeout para evitar espera infinita
   */
  async _fetchWithTimeout(fetchFn, timeoutMs) {
    return Promise.race([
      fetchFn(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout')), timeoutMs)
      )
    ]);
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
   * 🔥 UPDATE INCREMENTAL: Atualiza campos numéricos diretamente no cache
   * 
   * ZERO aggregate, ZERO rebuild, ZERO query pesada
   * Usado após complete/create/cancel para manter dashboard sempre fresco
   * 
   * @param {Object} updates - { fieldName: deltaValue }
   * @example incrementOverview({ completedSessions: 1, revenueToday: 150 })
   */
  async incrementOverview(updates) {
    if (!redisClient.isReady) return;
    
    const key = `${CACHE_PREFIX}admin-overview`;
    
    try {
      const cached = await redisClient.get(key);
      if (!cached) {
        // Cache não existe ainda, rebuild tradicional vai criar
        console.log(`[DashboardCache] ⚠️ Cache vazio, rebuild necessário`);
        return;
      }
      
      const data = JSON.parse(cached);
      
      // Aplica updates incrementais
      Object.entries(updates).forEach(([field, delta]) => {
        // Navega objeto aninhado (ex: sessions.today)
        const parts = field.split('.');
        let target = data;
        
        for (let i = 0; i < parts.length - 1; i++) {
          if (!target[parts[i]]) target[parts[i]] = {};
          target = target[parts[i]];
        }
        
        const lastKey = parts[parts.length - 1];
        if (typeof target[lastKey] === 'number') {
          target[lastKey] += delta;
          // Garante não ficar negativo
          if (target[lastKey] < 0) target[lastKey] = 0;
        }
      });
      
      // Atualiza timestamp
      data._cachedAt = new Date().toISOString();
      data._incrementalUpdate = true;
      
      await redisClient.setEx(key, CACHE_TTL, JSON.stringify(data));
      console.log(`[DashboardCache] ⚡ Incremental update:`, updates);
      
    } catch (err) {
      console.error(`[DashboardCache] ⚠️ Erro incremental:`, err.message);
      // Fallback silencioso - próximo GET vai fazer rebuild normal
    }
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
