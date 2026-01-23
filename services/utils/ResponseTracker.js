import MetricsService from './MetricsService.js';

class ResponseTracker {
    async track({
        messageId,
        intent,
        therapy,
        handler,
        duration,
        success,
        error
    }) {
        // Persistência (placeholder)
        await this.persist({
            messageId,
            intent,
            therapy,
            handler,
            duration,
            success,
            error: error ? String(error).slice(0, 500) : null,
            timestamp: new Date().toISOString()
        });

        // Métricas
        if (success) {
            MetricsService.incrementSuccess();
        } else {
            MetricsService.incrementError();
        }

        if (duration) {
            MetricsService.trackResponseTime(duration);
        }
    }

    async persist(data) {
        // Aqui entra Mongo / SQL / Log
        // Por enquanto: mantém compatível
        console.log('[TRACK]', data);
    }
}

export default new ResponseTracker();
