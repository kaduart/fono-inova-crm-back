/**
 * Financial Context - Controle de Fluxo Financeiro
 * 
 * Rastreia a origem de operações financeiras para prevenir loops
 * e garantir que apenas a autoridade financeira (Payment) atualize valores.
 * 
 * Regra: Payment → Session/Appointment (unidirecional)
 */

// Contexto global para rastreamento
export const FinancialContext = {
    current: null,
    
    set(ctx) {
        this.current = ctx;
    },
    
    get() {
        return this.current;
    },
    
    clear() {
        this.current = null;
    },
    
    isAuthorized(source) {
        return this.current === source;
    }
};

/**
 * Wrapper para executar código com contexto financeiro
 * Limpa automaticamente após execução (sucesso ou erro)
 */
export async function withFinancialContext(ctx, fn) {
    const previous = FinancialContext.get();
    FinancialContext.set(ctx);
    
    try {
        return await fn();
    } finally {
        // Restaurar contexto anterior ou limpar
        FinancialContext.set(previous);
    }
}

/**
 * Detecta tentativa de loop financeiro
 * Logs erro se detectado
 */
export function detectFinancialLoop(source, target) {
    const current = FinancialContext.get();
    
    // Loop: Payment → Session → Payment
    if (current === 'payment' && source === 'session') {
        console.error(`[FINANCIAL LOOP DETECTED] Tentativa de ${source} → ${target} enquanto Payment está atualizando`);
        return true;
    }
    
    // Loop: Session → Payment → Session
    if (current === 'session' && source === 'payment' && target === 'session') {
        console.error(`[FINANCIAL LOOP DETECTED] Tentativa de ${source} → ${target} enquanto Session está atualizando`);
        return true;
    }
    
    return false;
}

/**
 * Middleware Express para definir contexto em rotas
 */
export function financialContextMiddleware(source) {
    return (req, res, next) => {
        FinancialContext.set(source);
        
        // Garantir limpeza ao final
        res.on('finish', () => {
            FinancialContext.clear();
        });
        
        next();
    };
}

export default FinancialContext;
