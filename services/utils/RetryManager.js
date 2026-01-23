class RetryManager {
    constructor({ maxRetries = 3, baseDelay = 300 } = {}) {
        this.maxRetries = maxRetries;
        this.baseDelay = baseDelay;
    }

    async execute(fn, context = '') {
        let lastError;

        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            try {
                return await fn();
            } catch (error) {
                lastError = error;

                if (attempt === this.maxRetries) {
                    break;
                }

                await this.sleep(this.baseDelay * attempt);
            }
        }

        throw lastError;
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

export default new RetryManager();
