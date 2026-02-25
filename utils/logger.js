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

export default logger;
