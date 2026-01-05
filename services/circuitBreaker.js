class CircuitBreaker {
    constructor(name, options = {}) {
        this.name = name;
        this.failureThreshold = options.failureThreshold || 3;
        this.resetTimeout = options.resetTimeout || 30000; // 30s
        this.halfOpenRequests = options.halfOpenRequests || 1;

        this.failures = 0;
        this.successes = 0;
        this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
        this.lastFailure = null;
        this.halfOpenAttempts = 0;
    }

    async execute(fn, fallback) {
        // Se OPEN, verifica se pode tentar HALF_OPEN
        if (this.state === 'OPEN') {
            const timeSinceFailure = Date.now() - this.lastFailure;
            if (timeSinceFailure >= this.resetTimeout) {
                console.log(`[CIRCUIT:${this.name}] Tentando HALF_OPEN...`);
                this.state = 'HALF_OPEN';
                this.halfOpenAttempts = 0;
            } else {
                console.warn(`[CIRCUIT:${this.name}] OPEN - usando fallback`);
                return this._executeFallback(fallback);
            }
        }

        try {
            const result = await fn();
            this._onSuccess();
            return result;
        } catch (error) {
            this._onFailure(error);
            return this._executeFallback(fallback, error);
        }
    }

    async _executeFallback(fallback, originalError = null) {
        if (typeof fallback === 'function') {
            try {
                return await fallback(originalError);
            } catch (fallbackError) {
                console.error(`[CIRCUIT:${this.name}] Fallback também falhou:`, fallbackError.message);
                throw fallbackError;
            }
        }
        throw originalError || new Error('Circuit open and no fallback');
    }

    _onSuccess() {
        if (this.state === 'HALF_OPEN') {
            this.halfOpenAttempts++;
            if (this.halfOpenAttempts >= this.halfOpenRequests) {
                console.log(`[CIRCUIT:${this.name}] Recuperado! CLOSED`);
                this.state = 'CLOSED';
                this.failures = 0;
            }
        } else {
            this.failures = 0;
        }
        this.successes++;
    }

    _onFailure(error) {
        this.failures++;
        this.lastFailure = Date.now();

        console.error(`[CIRCUIT:${this.name}] Falha ${this.failures}/${this.failureThreshold}:`, error.message);

        if (this.state === 'HALF_OPEN') {
            console.warn(`[CIRCUIT:${this.name}] Falhou em HALF_OPEN → OPEN`);
            this.state = 'OPEN';
        } else if (this.failures >= this.failureThreshold) {
            console.error(`[CIRCUIT:${this.name}] Threshold atingido → OPEN`);
            this.state = 'OPEN';
        }
    }

    getStatus() {
        return {
            name: this.name,
            state: this.state,
            failures: this.failures,
            successes: this.successes,
            lastFailure: this.lastFailure,
        };
    }
}

// Instâncias pré-configuradas
export const claudeCircuit = new CircuitBreaker('claude', {
    failureThreshold: 3,
    resetTimeout: 30000,  // 30s
    halfOpenRequests: 2,
});

export const openaiCircuit = new CircuitBreaker('openai', {
    failureThreshold: 5,
    resetTimeout: 60000,  // 60s
    halfOpenRequests: 1,
});

export default CircuitBreaker;