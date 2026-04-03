/**
 * ============================================================================
 * FEATURE FLAGS - Billing V2
 * ============================================================================
 * 
 * Controle granular de ativação do V2 por etapa do fluxo.
 * Permite migração gradual e rollback imediato.
 * 
 * Estrutura:
 * - USE_V2_BILLING_CREATE: Criação de Appointment/Payment
 * - USE_V2_BILLING_BILLED: Faturamento (billed)
 * - USE_V2_BILLING_RECEIVED: Recebimento (paid)
 * - USE_V2_RECONCILIATION: Reconciliação automática
 * 
 * Prioridade:
 * 1. Variável de ambiente (process.env)
 * 2. Configuração em banco (FeatureFlag collection)
 * 3. Default: false (usa legado)
 * ============================================================================
 */

import mongoose from 'mongoose';

// Schema para persistir flags no banco
const featureFlagSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  enabled: { type: Boolean, default: false },
  description: String,
  updatedAt: { type: Date, default: Date.now },
  updatedBy: String
});

const FeatureFlag = mongoose.model('FeatureFlag', featureFlagSchema);

// Flags padrão
const DEFAULT_FLAGS = {
  USE_V2_BILLING_CREATE: {
    default: false,
    description: 'Usa V2 para criar Appointment/Payment na conclusão da sessão'
  },
  USE_V2_BILLING_BILLED: {
    default: false,
    description: 'Usa V2 para processar faturamento (billed)'
  },
  USE_V2_BILLING_RECEIVED: {
    default: false,
    description: 'Usa V2 para processar recebimento (paid)'
  },
  USE_V2_RECONCILIATION: {
    default: false,
    description: 'Ativa reconciliação automática diária'
  },
  USE_V2_WORKER: {
    default: false,
    description: 'Ativa worker BullMQ para processar eventos'
  }
};

class FeatureFlagService {
  constructor() {
    this.cache = new Map();
    this.cacheTTL = 60000; // 1 minuto
    this.lastFetch = 0;
  }
  
  /**
   * Verifica se uma flag está ativa
   */
  async isEnabled(flagKey) {
    // 1. Prioridade: variável de ambiente
    const envValue = process.env[flagKey];
    if (envValue !== undefined) {
      return envValue === 'true' || envValue === '1';
    }
    
    // 2. Cache válido?
    const now = Date.now();
    if (this.cache.has(flagKey) && (now - this.lastFetch) < this.cacheTTL) {
      return this.cache.get(flagKey);
    }
    
    // 3. Busca no banco
    try {
      const flag = await FeatureFlag.findOne({ key: flagKey });
      const enabled = flag ? flag.enabled : DEFAULT_FLAGS[flagKey]?.default || false;
      
      this.cache.set(flagKey, enabled);
      this.lastFetch = now;
      
      return enabled;
    } catch (error) {
      console.error(`[FeatureFlag] Error fetching ${flagKey}:`, error);
      // Fallback seguro: desativado
      return false;
    }
  }
  
  /**
   * Ativa/desativa uma flag
   */
  async setEnabled(flagKey, enabled, userId = 'system') {
    if (!DEFAULT_FLAGS[flagKey]) {
      throw new Error(`Unknown feature flag: ${flagKey}`);
    }
    
    await FeatureFlag.findOneAndUpdate(
      { key: flagKey },
      {
        $set: {
          enabled,
          updatedAt: new Date(),
          updatedBy: userId
        },
        $setOnInsert: {
          description: DEFAULT_FLAGS[flagKey].description
        }
      },
      { upsert: true }
    );
    
    // Invalida cache
    this.cache.delete(flagKey);
    
    console.log(`[FeatureFlag] ${flagKey} = ${enabled} (by ${userId})`);
    
    return { flagKey, enabled };
  }
  
  /**
   * Retorna status de todas as flags
   */
  async getAllStatus() {
    const result = {};
    
    for (const key of Object.keys(DEFAULT_FLAGS)) {
      result[key] = {
        enabled: await this.isEnabled(key),
        description: DEFAULT_FLAGS[key].description,
        source: process.env[key] !== undefined ? 'env' : 'db/default'
      };
    }
    
    return result;
  }
  
  /**
   * Ativa todas as flags de uma vez (para deploy)
   */
  async enableAll(userId = 'system') {
    const results = [];
    for (const key of Object.keys(DEFAULT_FLAGS)) {
      results.push(await this.setEnabled(key, true, userId));
    }
    return results;
  }
  
  /**
   * Desativa todas as flags (rollback de emergência)
   */
  async disableAll(userId = 'system') {
    const results = [];
    for (const key of Object.keys(DEFAULT_FLAGS)) {
      results.push(await this.setEnabled(key, false, userId));
    }
    console.warn(`[FeatureFlag] ALL FLAGS DISABLED by ${userId} - ROLLBACK EXECUTED`);
    return results;
  }
}

export const featureFlags = new FeatureFlagService();
export default featureFlags;
