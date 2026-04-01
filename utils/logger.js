/**
 * 📝 Logger simples
 * 
 * Wrapper em torno do console com prefixos padronizados.
 * Futuro: pode ser substituído por Winston ou Pino.
 */

const logger = {
  info: (message, ...args) => {
    console.log(`[INFO] ${new Date().toISOString()} — ${message}`, ...args);
  },
  
  error: (message, ...args) => {
    console.error(`[ERROR] ${new Date().toISOString()} — ${message}`, ...args);
  },
  
  warn: (message, ...args) => {
    console.warn(`[WARN] ${new Date().toISOString()} — ${message}`, ...args);
  },
  
  debug: (message, ...args) => {
    if (process.env.DEBUG || process.env.NODE_ENV === 'development') {
      console.log(`[DEBUG] ${new Date().toISOString()} — ${message}`, ...args);
    }
  }
};

/**
 * Cria um logger com contexto (correlationId e componente)
 * @param {string} correlationId - ID de correlação para rastreamento
 * @param {string} component - Nome do componente
 * @returns {Object} Logger contextualizado
 */
export function createContextLogger(correlationId, component) {
  const prefix = correlationId ? `[${correlationId}]` : '';
  const comp = component ? `[${component}]` : '';
  
  return {
    info: (event, message, meta = {}) => {
      console.log(`${prefix}${comp}[INFO] ${event}: ${message}`, meta);
    },
    
    error: (event, message, meta = {}) => {
      console.error(`${prefix}${comp}[ERROR] ${event}: ${message}`, meta);
    },
    
    warn: (event, message, meta = {}) => {
      console.warn(`${prefix}${comp}[WARN] ${event}: ${message}`, meta);
    },
    
    debug: (event, message, meta = {}) => {
      if (process.env.DEBUG || process.env.NODE_ENV === 'development') {
        console.log(`${prefix}${comp}[DEBUG] ${event}: ${message}`, meta);
      }
    }
  };
}

export default logger;
