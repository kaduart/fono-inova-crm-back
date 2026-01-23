const ResponseTracker = require('../services/utils/ResponseTracker');
const circuitBreaker = require('../circuitBreaker');
const Logger = require('../services/utils/Logger');

class BaseOrchestrator {
    constructor() {
        this.tracker = new ResponseTracker();
        this.logger = new Logger(this.constructor.name);
        this.circuitBreaker = circuitBreaker;
    }

    async executeWithCircuitBreaker(service, params, context = '') {
        try {
            return await this.circuitBreaker.fire(service, params);
        } catch (error) {
            this.logger.error(`Circuit breaker ativado em ${context}`, {
                error: error.message,
                service: service.name
            });
            throw error;
        }
    }

    logError(context, error, data = null) {
        this.logger.error(`[${this.constructor.name}] ${context}`, {
            message: error.message,
            stack: error.stack,
            data: this.sanitizeData(data),
            timestamp: new Date().toISOString()
        });
    }

    sanitizeData(data) {
        if (!data) return null;
        const sensitive = ['cpf', 'phone', 'email', 'password'];
        const sanitized = { ...data };
        sensitive.forEach(field => {
            if (sanitized[field]) sanitized[field] = '[REDACTED]';
        });
        return sanitized;
    }

    getFallbackResponse() {
        return {
            type: 'error',
            message: 'Desculpe, ocorreu um erro. Nossa equipe foi notificada.',
            action: 'retry'
        };
    }
}

module.exports = BaseOrchestrator;