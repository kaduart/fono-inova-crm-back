/**
 * 📋 WhitelistManager - Gerenciamento dinâmico de whitelist de nomes
 * 
 * Carrega de arquivo JSON (hot-reload) e permite adicionar em runtime
 * para evitar o engessamento de ter que fazer deploy para cada novo nome
 */

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Caminho para o arquivo de whitelist
const WHITELIST_PATH = join(__dirname, '../../config/nameWhitelist.json');

// Cache em memória (com timestamp para hot-reload)
let cache = {
  names: new Set(),
  loadedAt: null,
  fileExists: false
};

// Estatísticas de uso
const stats = {
  cacheHits: 0,
  fileReads: 0,
  runtimeAdditions: 0,
  lastReload: null
};

/**
 * 🔄 Carrega whitelist do arquivo JSON
 * Implementa hot-reload: só lê do disco se passou mais de 60s
 */
export function loadWhitelist(forceReload = false) {
  const now = Date.now();
  const cacheAge = cache.loadedAt ? now - cache.loadedAt : Infinity;
  
  // Usa cache se: não forçou reload E cache tem menos de 60s E cache existe
  if (!forceReload && cacheAge < 60000 && cache.names.size > 0) {
    stats.cacheHits++;
    return cache.names;
  }
  
  try {
    if (!existsSync(WHITELIST_PATH)) {
      console.warn('[WhitelistManager] Arquivo não encontrado:', WHITELIST_PATH);
      cache.fileExists = false;
      // Retorna whitelist mínima padrão
      return new Set(['ana', 'anoar', 'anísio']);
    }
    
    const content = readFileSync(WHITELIST_PATH, 'utf8');
    const data = JSON.parse(content);
    
    // Converte array para Set (busca O(1))
    cache.names = new Set(
      data.names.map(n => normalizeName(n))
    );
    cache.loadedAt = now;
    cache.fileExists = true;
    stats.fileReads++;
    stats.lastReload = new Date().toISOString();
    
    console.log('[WhitelistManager] Whitelist carregada:', {
      count: cache.names.size,
      from: WHITELIST_PATH,
      hotReload: !forceReload && cacheAge < 60000
    });
    
    return cache.names;
    
  } catch (error) {
    console.error('[WhitelistManager] Erro ao carregar:', error.message);
    // Fallback: retorna cache anterior ou whitelist mínima
    return cache.names.size > 0 ? cache.names : new Set(['ana']);
  }
}

/**
 * 🔍 Verifica se um nome está na whitelist
 */
export function isWhitelisted(name) {
  if (!name || typeof name !== 'string') return false;
  
  const normalized = normalizeName(name);
  const whitelist = loadWhitelist();
  
  // Verificação exata
  if (whitelist.has(normalized)) return true;
  
  // Verificação parcial (se nome contém palavra whitelistada)
  // Ex: "Ana Maria" contém "ana"
  for (const whitelisted of whitelist) {
    if (normalized.includes(whitelisted) || whitelisted.includes(normalized)) {
      return true;
    }
  }
  
  return false;
}

/**
 * ➕ Adiciona nome à whitelist em runtime (persiste no arquivo)
 */
export function addToWhitelist(name, options = {}) {
  const { persist = true, source = 'runtime' } = options;
  
  if (!name || typeof name !== 'string') {
    console.warn('[WhitelistManager] Tentativa de adicionar nome inválido:', name);
    return false;
  }
  
  const normalized = normalizeName(name);
  
  // Adiciona ao cache
  cache.names.add(normalized);
  stats.runtimeAdditions++;
  
  console.log(`[WhitelistManager] Nome adicionado${persist ? ' (persistente)' : ' (temporário)'}:`, name);
  
  // Persiste no arquivo se solicitado
  if (persist) {
    try {
      let data = { names: [], autoAddedFromProduction: [] };
      
      if (existsSync(WHITELIST_PATH)) {
        const content = readFileSync(WHITELIST_PATH, 'utf8');
        data = JSON.parse(content);
      }
      
      // Adiciona na lista apropriada
      if (source === 'production') {
        if (!data.autoAddedFromProduction) data.autoAddedFromProduction = [];
        data.autoAddedFromProduction.push({
          name: normalized,
          addedAt: new Date().toISOString(),
          reason: options.reason || 'auto-detected'
        });
      } else {
        data.names.push(normalized);
      }
      
      // Atualiza estatísticas
      data.statistics = {
        totalNames: data.names.length + (data.autoAddedFromProduction?.length || 0),
        addedBySystem: data.autoAddedFromProduction?.length || 0,
        addedManually: data.names.length,
        lastUpdated: new Date().toISOString()
      };
      
      writeFileSync(WHITELIST_PATH, JSON.stringify(data, null, 2), 'utf8');
      console.log('[WhitelistManager] Persistido em:', WHITELIST_PATH);
      
    } catch (error) {
      console.error('[WhitelistManager] Erro ao persistir:', error.message);
      return false;
    }
  }
  
  return true;
}

/**
 * 🧹 Normaliza nome para comparação
 */
function normalizeName(name) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')  // Remove acentos
    .trim();
}

/**
 * 📊 Retorna estatísticas
 */
export function getWhitelistStats() {
  return {
    ...stats,
    cachedNames: cache.names.size,
    cacheAge: cache.loadedAt ? Date.now() - cache.loadedAt : null,
    fileExists: cache.fileExists
  };
}

/**
 * 🔄 Força reload do arquivo
 */
export function reloadWhitelist() {
  return loadWhitelist(true);
}

/**
 * 🔧 Verifica se arquivo existe e é válido
 */
export function validateWhitelistFile() {
  try {
    if (!existsSync(WHITELIST_PATH)) {
      return { valid: false, error: 'File not found', path: WHITELIST_PATH };
    }
    
    const content = readFileSync(WHITELIST_PATH, 'utf8');
    const data = JSON.parse(content);
    
    if (!Array.isArray(data.names)) {
      return { valid: false, error: 'Invalid format: names must be array' };
    }
    
    return { 
      valid: true, 
      count: data.names.length,
      path: WHITELIST_PATH
    };
    
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

export default {
  loadWhitelist,
  isWhitelisted,
  addToWhitelist,
  getWhitelistStats,
  reloadWhitelist,
  validateWhitelistFile
};
