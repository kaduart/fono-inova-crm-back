class MetricsService {
    constructor() {
        this.reset();
    }

    reset() {
        this.metrics = {
            successCount: 0,
            errorCount: 0,
            responseTimes: []
        };
    }

    incrementSuccess() {
        this.metrics.successCount++;
    }

    incrementError() {
        this.metrics.errorCount++;
    }

    trackResponseTime(durationMs) {
        if (typeof durationMs === 'number') {
            this.metrics.responseTimes.push(durationMs);
        }
    }

    getSnapshot() {
        const times = this.metrics.responseTimes;

        return {
            successCount: this.metrics.successCount,
            errorCount: this.metrics.errorCount,
            avgResponseTime:
                times.length > 0
                    ? times.reduce((a, b) => a + b, 0) / times.length
                    : 0
        };
    }
}

export default new MetricsService();
