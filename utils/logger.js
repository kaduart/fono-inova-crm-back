/**
 * 📝 Logger simples
 * 
 * Wrapper em torno do console com prefixos padronizados.
 * Futuro: pode ser substituído por Winston ou Pino.
 */

const MAX_META_KEYS = 10;
const MAX_STRING_LENGTH = 120;

function sanitizeMeta(meta) {
  if (!meta || typeof meta !== 'object') return {};

  const result = {};
  const entries = Object.entries(meta).slice(0, MAX_META_KEYS);

  for (const [key, value] of entries) {
    if (value == null) {
      result[key] = value;
      continue;
    }

    if (typeof value === 'string') {
      result[key] =
        value.length > MAX_STRING_LENGTH
          ? value.slice(0, MAX_STRING_LENGTH) + '...'
          : value;
      continue;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      result[key] = value;
      continue;
    }

    if (typeof value === 'object') {
      result[key] =
        value._id?.toString?.() ||
        value.id?.toString?.() ||
        value.eventId?.toString?.() ||
        value.jobId?.toString?.() ||
        value.correlationId?.toString?.() ||
        '[Object]';
      continue;
    }

    result[key] = '[Unknown]';
  }

  if (Object.keys(meta).length > MAX_META_KEYS) {
    result._truncated = true;
  }

  return result;
}

const logger = {
  info: (message, ...args) => {
    const sanitizedArgs = args.map(arg => sanitizeMeta(arg));
    console.log(`[INFO] ${new Date().toISOString()} — ${message}`, ...sanitizedArgs);
  },
  
  error: (message, ...args) => {
    const sanitizedArgs = args.map(arg => sanitizeMeta(arg));
    console.error(`[ERROR] ${new Date().toISOString()} — ${message}`, ...sanitizedArgs);
  },
  
  warn: (message, ...args) => {
    const sanitizedArgs = args.map(arg => sanitizeMeta(arg));
    console.warn(`[WARN] ${new Date().toISOString()} — ${message}`, ...sanitizedArgs);
  },
  
  debug: (message, ...args) => {
    if (process.env.DEBUG || process.env.NODE_ENV === 'development') {
      const sanitizedArgs = args.map(arg => sanitizeMeta(arg));
      console.log(`[DEBUG] ${new Date().toISOString()} — ${message}`, ...sanitizedArgs);
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
      console.log(`${prefix}${comp}[INFO] ${event}: ${message}`, sanitizeMeta(meta));
    },
    
    error: (event, message, meta = {}) => {
      console.error(`${prefix}${comp}[ERROR] ${event}: ${message}`, sanitizeMeta(meta));
    },
    
    warn: (event, message, meta = {}) => {
      console.warn(`${prefix}${comp}[WARN] ${event}: ${message}`, sanitizeMeta(meta));
    },
    
    debug: (event, message, meta = {}) => {
      if (process.env.DEBUG || process.env.NODE_ENV === 'development') {
        console.log(`${prefix}${comp}[DEBUG] ${event}: ${message}`, sanitizeMeta(meta));
      }
    }
  };
}

export default logger;
