// utils/paymentResolver.js
// 🏥 ARQUITETURA v4.0 - Centralização de Regras de Pagamento
// ÚNICO lugar onde a lógica de decisão financeira deve existir

/**
 * Resolve o tipo de processamento financeiro baseado no contexto
 * @param {Object} params - Parâmetros de entrada
 * @param {boolean} params.addToBalance - Se é fiado (saldo devedor)
 * @param {Object} params.packageData - Dados do pacote (se houver)
 * @param {Object} params.appointmentData - Dados do agendamento
 * @param {Object} params.body - Body da requisição
 * @returns {Object} Resolução completa do fluxo financeiro
 */
export function resolvePaymentType({ addToBalance, packageData, appointmentData, body }) {
    // Prioridade 1: Flag explícita de fiado
    if (addToBalance === true) {
        return {
            type: 'manual_balance',
            createPayment: false,
            updatePackageFinancially: false,
            requiresBalanceDebit: true,
            finalStatus: 'pending',
            paymentStatus: 'pending',
            isPaid: false,
            visualFlag: 'pending',
            description: 'Sessão fiada - pagamento pendente no saldo do paciente'
        };
    }
    
    // Prioridade 2: Convênio (recebível, não entrada de caixa imediata)
    if (packageData?.type === 'convenio' || appointmentData?.billingType === 'convenio') {
        return {
            type: 'convenio',
            createPayment: true,     // Cria como recebível (status: pending_receipt)
            paymentStatus: 'pending_receipt',
            updatePackageFinancially: false,  // Convênio não entra no caixa ainda
            requiresBalanceDebit: false,
            finalStatus: 'pending_receipt',
            isPaid: false,
            visualFlag: 'pending',
            description: 'Sessão de convênio - aguardando recebimento'
        };
    }
    
    // Prioridade 3: Liminar
    if (packageData?.type === 'liminar') {
        return {
            type: 'liminar',
            createPayment: true,
            updatePackageFinancially: false,
            requiresBalanceDebit: false,
            finalStatus: 'pending',
            paymentStatus: 'pending',
            isPaid: false,
            visualFlag: 'pending',
            description: 'Sessão de liminar - processo judicial'
        };
    }
    
    // Prioridade 4: Per-session (paga no ato da conclusão)
    if (packageData?.paymentType === 'per-session') {
        return {
            type: 'auto_per_session',
            createPayment: true,     // Cria payment imediatamente
            paymentStatus: 'paid',
            updatePackageFinancially: true,  // Incrementa totalPaid do pacote
            requiresBalanceDebit: false,
            finalStatus: 'paid',
            isPaid: true,
            visualFlag: 'ok',
            description: 'Pagamento automático no ato da sessão'
        };
    }
    
    // Prioridade 5: Pacote pré-pago (full/partial já pagos anteriormente)
    if (packageData && ['full', 'partial'].includes(packageData.paymentType)) {
        return {
            type: 'package_prepaid',
            createPayment: false,    // Já foi pago na compra do pacote
            paymentStatus: 'package_paid',
            updatePackageFinancially: false,  // Não muda financeiro, só consome sessão
            requiresBalanceDebit: false,
            finalStatus: 'paid',
            isPaid: true,
            visualFlag: 'ok',
            description: 'Sessão coberta por pacote pré-pago'
        };
    }
    
    // Padrão: Sessão avulsa individual
    return {
        type: 'individual',
        createPayment: body.paymentConfirmed !== false,
        paymentStatus: body.paymentConfirmed !== false ? 'paid' : 'pending',
        updatePackageFinancially: false,
        requiresBalanceDebit: false,
        finalStatus: body.paymentConfirmed !== false ? 'paid' : 'pending',
        isPaid: body.paymentConfirmed !== false,
        visualFlag: body.paymentConfirmed !== false ? 'ok' : 'pending',
        description: 'Sessão avulsa individual'
    };
}

/**
 * Valida consistência da resolução antes de processar
 * @param {Object} resolution - Resolução do resolvePaymentType
 * @param {Object} context - Contexto da operação
 * @returns {string[]} Array de erros (vazio se válido)
 */
export function validateResolution(resolution, context) {
    const errors = [];
    
    if (resolution.type === 'manual_balance' && !context.patientId) {
        errors.push('Fiado (manual_balance) requer patientId');
    }
    
    if (resolution.type === 'auto_per_session' && !context.sessionValue) {
        errors.push('Per-session requer valor de sessão (sessionValue)');
    }
    
    if (resolution.updatePackageFinancially && !context.packageId) {
        errors.push('Atualização financeira de pacote requer packageId');
    }
    
    if (resolution.createPayment && !context.patientId) {
        errors.push('Criação de Payment requer patientId');
    }
    
    return errors;
}

/**
 * Gera correlationId único para rastreamento
 * @returns {string} Correlation ID
 */
export function generateCorrelationId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export default {
    resolvePaymentType,
    validateResolution,
    generateCorrelationId
};
