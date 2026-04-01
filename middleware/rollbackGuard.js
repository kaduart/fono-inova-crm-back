// middleware/rollbackGuard.js
/**
 * Rollback Guard - Monitora saúde do V2 e ativa rollback automático
 */

import { getRedis } from '../services/redisClient.js';

const ERROR_THRESHOLD = parseInt(process.env.FF_ERROR_THRESHOLD || '10');
const ERROR_WINDOW = parseInt(process.env.FF_ERROR_WINDOW || '60'); // segundos

const redis = getRedis();

export class RollbackGuard {
  static async trackError(operation, error) {
    const key = `v2:errors:${Date.now()}`;
    await redis.setex(key, ERROR_WINDOW, JSON.stringify({
      operation,
      error: error.message,
      timestamp: new Date().toISOString()
    }));
  }
  
  static async checkHealth() {
    // Conta erros na janela de tempo
    const keys = await redis.keys('v2:errors:*');
    const now = Date.now();
    const windowStart = now - (ERROR_WINDOW * 1000);
    
    let errorCount = 0;
    for (const key of keys) {
      const timestamp = parseInt(key.split(':')[2]);
      if (timestamp > windowStart) {
        errorCount++;
      }
    }
    
    const healthy = errorCount < ERROR_THRESHOLD;
    
    if (!healthy) {
      console.error(`🚨 ROLLBACK GUARD: ${errorCount} erros em ${ERROR_WINDOW}s`);
      await redis.setex('emergency_rollback', 300, 'true');
    }
    
    return {
      healthy,
      errorCount,
      threshold: ERROR_THRESHOLD,
      emergencyRollback: !healthy
    };
  }
  
  static async isEmergencyRollback() {
    const rollback = await redis.get('emergency_rollback');
    return rollback === 'true';
  }
  
  static async clearRollback() {
    await redis.del('emergency_rollback');
    console.log('✅ Rollback manual cancelado');
  }
}

// Middleware para rotas
export function rollbackGuardMiddleware(req, res, next) {
  RollbackGuard.checkHealth().then(status => {
    if (status.emergencyRollback) {
      console.warn('🚨 Emergency rollback ativo - bloqueando V2');
    }
    next();
  }).catch(next);
}
