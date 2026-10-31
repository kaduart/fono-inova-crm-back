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
    // 🐛 FIX (auditoria 31/10/2026, B4): arrays (blocos doctors/upcoming) perdiam o
    // `_cachedAt` no JSON.stringify — todo HIT virava "rebuild=true" e as queries
    // rodavam a cada acesso. Agora arrays vão embrulhados em { __array, _cachedAt }.
    const pack = (value) => (Array.isArray(value)
      ? { __array: value, _cachedAt: new Date().toISOString() }
      : Object.assign(value ?? {}, { _cachedAt: new Date().toISOString() }));
    const unpack = (stored) => (stored && Array.isArray(stored.__array) ? stored.__array : stored);

    let cachedRaw = null;
    try {
      cachedRaw = await this.get(key);
    } catch (err) {
      console.error(`[DashboardCache] Erro ao ler ${key}: ${err.message}`);
    }

    if (cachedRaw) {
      const stored = JSON.parse(cachedRaw);
      const ageMs = stored?._cachedAt ? Date.now() - new Date(stored._cachedAt).getTime() : null;
      const shouldRebuild = ageMs == null || ageMs > (ttl * 1000 / 2);
      console.log(`[DashboardCache] HIT ${key} age=${ageMs != null ? Math.round(ageMs / 1000) + 's' : '?'} rebuild=${shouldRebuild}`);

      if (shouldRebuild && !this.revalidating.has(key)) {
        this.revalidating.add(key);
        setImmediate(async () => {
          try {
            const fresh = await fetchFn();
            await this.set(key, pack(fresh), ttl);
          } catch (err) {
            console.error(`[DashboardCache] ⚠️ Rebuild erro: ${err.message}`);
          } finally {
            this.revalidating.delete(key);
          }
        });
      }
      return unpack(stored);
    }

    // MISS: uma única execução do builder. 🐛 FIX (B5): antes, se passasse de 5s, o
    // catch chamava fetchFn() DE NOVO com a primeira ainda rodando (carga em dobro
    // justo quando o Mongo está lento). Agora o timeout só gera log e esperamos a
    // MESMA promise; MISS simultâneos da mesma chave também compartilham a promise.
    if (!this.inFlight) this.inFlight = new Map();
    if (this.inFlight.has(key)) return this.inFlight.get(key);

    console.log(`[DashboardCache] MISS ${key} — executando builder...`);
    const t0 = Date.now();
    const slowTimer = setTimeout(() => {
      console.warn(`[DashboardCache] ⏳ ${key} passou de 5s (aguardando a mesma execução)`);
    }, 5000);
    const promise = (async () => {
      try {
        const data = await fetchFn();
        console.log(`[DashboardCache] MISS ${key} resolvido em ${Date.now() - t0}ms`);
        this.set(key, pack(data), ttl).catch(err =>
          console.error(`[DashboardCache] Erro ao salvar cache: ${err.message}`)
        );
        return unpack(data);
      } finally {
        clearTimeout(slowTimer);
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, promise);
    return promise;
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
      if (!cached) return;
      
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
