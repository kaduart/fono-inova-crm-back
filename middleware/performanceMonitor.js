/**
 * Middleware para monitorar performance de rotas
 * Loga rotas lentas (> 1s) automaticamente
 */

const performanceMonitor = (req, res, next) => {
    const startTime = process.hrtime.bigint();
    const startDate = Date.now();
    
    // Guardar referência original
    const originalSend = res.send;
    const originalJson = res.json;
    
    // Função para calcular tempo
    const logPerformance = () => {
        const endTime = process.hrtime.bigint();
        const durationMs = Number(endTime - startTime) / 1_000_000; // nanosegundos -> ms
        const durationSec = (durationMs / 1000).toFixed(2);
        
        // Logar apenas rotas lentas (> 1s) ou todas em desenvolvimento
        const shouldLog = durationMs > 1000 || process.env.NODE_ENV === 'development';
        
        if (shouldLog) {
            const method = req.method;
            const url = req.originalUrl;
            const status = res.statusCode;
            
            // Emoji baseado na velocidade
            let emoji = '⚡';
            if (durationMs > 1000) emoji = '🐢';
            if (durationMs > 5000) emoji = '🐌';
            if (durationMs > 10000) emoji = '🔥';
            
            console.log(`${emoji} [${method}] ${url} - ${status} - ${durationSec}s`);
            
            // Se for muito lento, logar mais detalhes
            if (durationMs > 5000) {
                console.warn(`⚠️  ROTA LENTA DETECTADA: ${method} ${url}`);
                console.warn(`   Tempo: ${durationSec}s`);
                console.warn(`   Query params:`, req.query);
                console.warn(`   Body:`, Object.keys(req.body || {}));
            }
        }
    };
    
    // Interceptar res.send
    res.send = function(data) {
        logPerformance();
        return originalSend.call(this, data);
    };
    
    // Interceptar res.json
    res.json = function(data) {
        logPerformance();
        return originalJson.call(this, data);
    };
    
    next();
};

/**
 * Wrapper para monitorar funções específicas
 * Útil para transações MongoDB
 */
const monitorAsync = (fn, operationName) => {
    return async (...args) => {
        const start = Date.now();
        try {
            const result = await fn(...args);
            const duration = Date.now() - start;
            
            if (duration > 1000) {
                console.warn(`🐢 Operação lenta: ${operationName} - ${(duration/1000).toFixed(2)}s`);
            }
            
            return result;
        } catch (error) {
            const duration = Date.now() - start;
            console.error(`❌ Erro em ${operationName} após ${(duration/1000).toFixed(2)}s:`, error.message);
            throw error;
        }
    };
};

/**
 * Middleware para adicionar headers de timing
 */
const timingHeaders = (req, res, next) => {
    const start = Date.now();
    
    res.on('finish', () => {
        const duration = Date.now() - start;
        res.setHeader('X-Response-Time', `${duration}ms`);
        
        if (duration > 5000) {
            res.setHeader('X-Slow-Route', 'true');
        }
    });
    
    next();
};

module.exports = {
    performanceMonitor,
    monitorAsync,
    timingHeaders
};
