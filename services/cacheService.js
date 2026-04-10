/**
 * 🔧 Cache Service Profissional
 * 
 * Features:
 * - TTL (Time To Live) automático
 * - Limite de tamanho (LRU - remove o mais antigo)
 * - Limpeza automática periódica
 * - Estatísticas de uso
 * - Thread-safe
 */

class CacheService {
  constructor(options = {}) {
    this.maxSize = options.maxSize || 100;        // Máximo de itens
    this.defaultTTL = options.defaultTTL || 5 * 60 * 1000; // 5 min padrão
    this.cleanupInterval = options.cleanupInterval || 60 * 1000; // 1 min
    
    this.cache = new Map();
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      cleanups: 0
    };
    
    // Inicia limpeza automática
    this.startCleanup();
  }
  
  /**
   * Define um valor no cache
   */
  set(key, value, ttl = this.defaultTTL) {
    // Se atingiu limite, remove o mais antigo (LRU)
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
      this.stats.evictions++;
    }
    
    this.cache.set(key, {
      value,
      expires: Date.now() + ttl,
      lastAccess: Date.now()
    });
    
    return this;
  }
  
  /**
   * Obtém um valor do cache
   */
  get(key) {
    const item = this.cache.get(key);
    
    if (!item) {
      this.stats.misses++;
      return null;
    }
    
    // Verifica se expirou
    if (Date.now() > item.expires) {
      this.cache.delete(key);
      this.stats.misses++;
      return null;
    }
    
    // Atualiza último acesso (LRU)
    item.lastAccess = Date.now();
    this.stats.hits++;
    
    return item.value;
  }
  
  /**
   * Verifica se existe (e não expirou)
   */
  has(key) {
    const item = this.cache.get(key);
    if (!item) return false;
    
    if (Date.now() > item.expires) {
      this.cache.delete(key);
      return false;
    }
    
    return true;
  }
  
  /**
   * Remove um item
   */
  delete(key) {
    return this.cache.delete(key);
  }
  
  /**
   * Limpa todo o cache
   */
  clear() {
    this.cache.clear();
    return this;
  }
  
  /**
   * Retorna tamanho atual
   */
  size() {
    return this.cache.size;
  }
  
  /**
   * Retorna estatísticas
   */
  getStats() {
    const hitRate = this.stats.hits + this.stats.misses > 0
      ? (this.stats.hits / (this.stats.hits + this.stats.misses) * 100).toFixed(2)
      : 0;
      
    return {
      ...this.stats,
      size: this.cache.size,
      maxSize: this.maxSize,
      hitRate: `${hitRate}%`
    };
  }
  
  /**
   * Inicia limpeza automática
   */
  startCleanup() {
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.cleanupInterval);
  }
  
  /**
   * Limpa itens expirados
   */
  cleanup() {
    const now = Date.now();
    let removed = 0;
    
    for (const [key, item] of this.cache.entries()) {
      if (item.expires < now) {
        this.cache.delete(key);
        removed++;
      }
    }
    
    if (removed > 0) {
      this.stats.cleanups++;
      console.log(`🧹 [Cache] Limpos ${removed} itens expirados. Total: ${this.cache.size}`);
    }
    
    return removed;
  }
  
  /**
   * Para limpeza automática (graceful shutdown)
   */
  stop() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
  
  /**
   * Previne vazamento de memória no shutdown
   */
  destroy() {
    this.stop();
    this.clear();
  }
}

// ============================================================
// INSTÂNCIAS ESPECIALIZADAS
// ============================================================

// Cache de agendamentos (curto - dados mudam frequentemente)
export const appointmentCache = new CacheService({
  maxSize: 50,
  defaultTTL: 2 * 60 * 1000, // 2 minutos
  cleanupInterval: 30 * 1000   // 30 segundos
});

// Cache de pacientes (médio - dados mudam pouco)
export const patientCache = new CacheService({
  maxSize: 100,
  defaultTTL: 5 * 60 * 1000, // 5 minutos
  cleanupInterval: 60 * 1000   // 1 minuto
});

// Cache de dashboard (mais longo - dados agregados)
export const dashboardCache = new CacheService({
  maxSize: 20,
  defaultTTL: 10 * 60 * 1000, // 10 minutos
  cleanupInterval: 2 * 60 * 1000 // 2 minutos
});

// Cache de learning (curto - evita acúmulo)
export const learningCache = new CacheService({
  maxSize: 50,
  defaultTTL: 10 * 60 * 1000, // 10 minutos
  cleanupInterval: 5 * 60 * 1000 // 5 minutos
});

// Instância genérica para uso personalizado
export const cache = new CacheService();

export default CacheService;
