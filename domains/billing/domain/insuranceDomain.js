// insurance/domain/insuranceDomain.js
/**
 * Insurance Domain Logic
 * 
 * Regras de negócio puras para faturamento de convênios.
 * Sem side effects - apenas processamento e decisões.
 */

import { generateTissXml } from '../integrations/tiss/tissGenerator.js';
import { sendToInsuranceProvider } from '../integrations/tiss/providerGateway.js';

// ============================================
// BATCH PROCESSING
// ============================================

/**
 * Processa um lote de faturamento
 * - Valida itens
 * - Agrupa por convênio
 * - Gera XML TISS
 * - Retorna dados para envio
 */
export async function processInsuranceBatch(batch, options = {}) {
    const { log } = options;
    
    // Validações
    const validation = validateBatch(batch);
    if (!validation.valid) {
        return {
            success: false,
            error: validation.error,
            details: validation.details
        };
    }
    
    // Agrupa itens por tipo de guia (se necessário)
    const groupedItems = groupItemsByGuideType(batch.items);
    
    // Gera XML TISS
    let xmlContent;
    try {
        xmlContent = await generateTissXml({
            batchNumber: batch.batchNumber,
            insuranceProvider: batch.insuranceProvider,
            insuranceProviderCode: batch.insuranceProviderCode,
            startDate: batch.startDate,
            endDate: batch.endDate,
            items: batch.items,
            providerInfo: options.providerInfo || {}
        });
    } catch (error) {
        log?.error?.('xml_generation_failed', 'Falha ao gerar XML TISS', { 
            error: error.message,
            batchId: batch._id
        });
        return {
            success: false,
            error: 'XML_GENERATION_FAILED',
            details: error.message
        };
    }
    
    return {
        success: true,
        xmlContent,
        itemCount: batch.items.length,
        totalGross: batch.totalGross,
        groupedItems
    };
}

/**
 * Envia lote para operadora
 * - Prepara payload
 * - Envia via gateway
 * - Retorna protocolo
 */
export async function sendBatchToProvider(batch, xmlContent, options = {}) {
    const { correlationId, log } = options;
    
    log?.info?.('sending_to_provider', 'Enviando lote para operadora', {
        batchId: batch._id,
        batchNumber: batch.batchNumber,
        provider: batch.insuranceProvider
    });
    
    try {
        const result = await sendToInsuranceProvider({
            provider: batch.insuranceProvider,
            providerCode: batch.insuranceProviderCode,
            batchNumber: batch.batchNumber,
            xmlContent,
            correlationId
        });
        
        if (!result.success) {
            return {
                success: false,
                error: result.error || 'SEND_FAILED',
                details: result.details
            };
        }
        
        log?.info?.('batch_sent', 'Lote enviado com sucesso', {
            batchId: batch._id,
            protocol: result.protocol
        });
        
        return {
            success: true,
            protocol: result.protocol,
            sentAt: new Date()
        };
        
    } catch (error) {
        log?.error?.('send_failed', 'Falha ao enviar lote', {
            error: error.message,
            batchId: batch._id
        });
        
        return {
            success: false,
            error: 'SEND_EXCEPTION',
            details: error.message
        };
    }
}

// ============================================
// VALIDATION
// ============================================

/**
 * Valida um lote antes de processar
 */
export function validateBatch(batch) {
    const errors = [];
    
    // Valida campos obrigatórios
    if (!batch.insuranceProvider) {
        errors.push('Convênio não informado');
    }
    
    if (!batch.items || batch.items.length === 0) {
        errors.push('Lote sem itens');
    }
    
    // Valida cada item
    batch.items?.forEach((item, index) => {
        if (!item.sessionId) {
            errors.push(`Item ${index + 1}: sessão não informada`);
        }
        if (!item.patientId) {
            errors.push(`Item ${index + 1}: paciente não informado`);
        }
        if (!item.procedureCode) {
            errors.push(`Item ${index + 1}: código do procedimento não informado`);
        }
        if (!item.grossAmount || item.grossAmount <= 0) {
            errors.push(`Item ${index + 1}: valor inválido`);
        }
        if (!item.sessionDate) {
            errors.push(`Item ${index + 1}: data da sessão não informada`);
        }
    });
    
    // Valida soma dos valores
    const calculatedTotal = batch.items?.reduce((sum, item) => sum + (item.grossAmount || 0), 0) || 0;
    if (Math.abs(calculatedTotal - batch.totalGross) > 0.01) {
        errors.push(`Divergência no valor total: calculado ${calculatedTotal}, informado ${batch.totalGross}`);
    }
    
    if (errors.length > 0) {
        return {
            valid: false,
            error: 'VALIDATION_FAILED',
            details: errors
        };
    }
    
    return { valid: true };
}

/**
 * Valida se item pode ser adicionado ao lote
 */
export function canAddItemToBatch(batch, item) {
    // Não pode adicionar a lote já enviado
    if (['sent', 'completed', 'failed', 'cancelled'].includes(batch.status)) {
        return {
            canAdd: false,
            reason: 'BATCH_ALREADY_SENT'
        };
    }
    
    // Verifica duplicidade (mesma sessão)
    const existingItem = batch.items.find(i => 
        i.sessionId?.toString() === item.sessionId?.toString()
    );
    
    if (existingItem) {
        return {
            canAdd: false,
            reason: 'SESSION_ALREADY_IN_BATCH',
            existingItemId: existingItem._id
        };
    }
    
    // Verifica período do lote
    const itemDate = new Date(item.sessionDate);
    if (itemDate < batch.startDate || itemDate > batch.endDate) {
        return {
            canAdd: false,
            reason: 'DATE_OUTSIDE_BATCH_PERIOD',
            batchPeriod: { start: batch.startDate, end: batch.endDate }
        };
    }
    
    return { canAdd: true };
}

// ============================================
// GROUPING & ORGANIZATION
// ============================================

/**
 * Agrupa itens por tipo de guia
 * Útil quando o convênio exige guias separadas
 */
export function groupItemsByGuideType(items) {
    const groups = {
        consultation: [], // Consultas
        procedure: [],    // Procedimentos
        therapy: [],      // Terapias
        other: []         // Outros
    };
    
    items.forEach(item => {
        const code = item.procedureCode || '';
        
        // Classifica por código TISS (exemplos)
        if (code.startsWith('101')) {
            groups.consultation.push(item);
        } else if (code.startsWith('201') || code.startsWith('301')) {
            groups.procedure.push(item);
        } else if (code.startsWith('4') || code.startsWith('5')) {
            groups.therapy.push(item);
        } else {
            groups.other.push(item);
        }
    });
    
    return groups;
}

/**
 * Calcula métricas do lote
 */
export function calculateBatchMetrics(batch) {
    const items = batch.items || [];
    const total = items.length;
    
    if (total === 0) {
        return {
            totalItems: 0,
            approvedCount: 0,
            rejectedCount: 0,
            pendingCount: 0,
            approvalRate: 0,
            glosaRate: 0,
            averageItemValue: 0
        };
    }
    
    const approved = items.filter(i => i.status === 'approved').length;
    const rejected = items.filter(i => i.status === 'rejected').length;
    const pending = items.filter(i => ['pending', 'sent', 'retrying'].includes(i.status)).length;
    
    const totalGlosa = items.reduce((sum, i) => sum + (i.glosaAmount || 0), 0);
    const totalGross = items.reduce((sum, i) => sum + (i.grossAmount || 0), 0);
    
    return {
        totalItems: total,
        approvedCount: approved,
        rejectedCount: rejected,
        pendingCount: pending,
        approvalRate: (approved / total) * 100,
        glosaRate: totalGross > 0 ? (totalGlosa / totalGross) * 100 : 0,
        averageItemValue: totalGross / total
    };
}

// ============================================
// GLOSA HANDLING
// ============================================

/**
 * Analisa glosa e determina próxima ação
 */
export function analyzeGlosa(glosaData) {
    const { code, reason, amount } = glosaData;
    
    // Classifica severidade
    const severity = classifyGlosaSeverity(code);
    
    // Determina ação recomendada
    const action = determineGlosaAction(code, severity);
    
    // Calcula impacto financeiro
    const impact = calculateGlosaImpact(amount, severity);
    
    return {
        code,
        reason,
        severity,
        action,
        impact,
        isRecoverable: severity !== 'critical',
        requiresManualReview: severity === 'high' || severity === 'critical'
    };
}

/**
 * Classifica severidade da glosa
 */
function classifyGlosaSeverity(code) {
    if (!code) return 'unknown';
    
    const criticalCodes = ['5010', '5020', '5030']; // Erros críticos
    const highCodes = ['4010', '4020', '4030']; // Recusas de cobertura
    const mediumCodes = ['3010', '3020', '3030']; // Problemas de autorização
    const lowCodes = ['2010', '2020', '2030']; // Erros de dados
    
    if (criticalCodes.some(c => code.startsWith(c))) return 'critical';
    if (highCodes.some(c => code.startsWith(c))) return 'high';
    if (mediumCodes.some(c => code.startsWith(c))) return 'medium';
    if (lowCodes.some(c => code.startsWith(c))) return 'low';
    
    return 'medium';
}

/**
 * Determina ação para glosa
 */
function determineGlosaAction(code, severity) {
    if (severity === 'low') return 'auto_retry';
    if (severity === 'medium') return 'manual_review';
    if (severity === 'high') return 'appeal';
    return 'write_off';
}

/**
 * Calcula impacto financeiro
 */
function calculateGlosaImpact(amount, severity) {
    const severityMultiplier = {
        low: 1,
        medium: 2,
        high: 3,
        critical: 5
    };
    
    return {
        amount,
        severityWeight: severityMultiplier[severity] || 1,
        priorityScore: (amount || 0) * (severityMultiplier[severity] || 1)
    };
}

// ============================================
// RECONCILIATION
// ============================================

/**
 * Concilia pagamento recebido com lote
 */
export function reconcilePayment(batch, paymentData) {
    const expectedAmount = batch.totalNet;
    const receivedAmount = paymentData.amount;
    const difference = receivedAmount - expectedAmount;
    
    const tolerance = 0.01; // tolerância de 1 centavo
    
    let status = 'pending';
    let discrepancies = [];
    
    if (Math.abs(difference) <= tolerance) {
        status = 'completed';
    } else {
        status = 'partial';
        
        if (difference < 0) {
            discrepancies.push({
                type: 'shortfall',
                amount: Math.abs(difference),
                description: 'Pagamento menor que o esperado'
            });
        } else {
            discrepancies.push({
                type: 'overage',
                amount: difference,
                description: 'Pagamento maior que o esperado'
            });
        }
    }
    
    // Verifica se todos os itens aprovados estão pagos
    const approvedItems = batch.items.filter(i => i.status === 'approved');
    const paidItems = paymentData.items || [];
    
    const unpaidItems = approvedItems.filter(approved => 
        !paidItems.some(paid => paid.itemId?.toString() === approved._id?.toString())
    );
    
    if (unpaidItems.length > 0) {
        status = 'partial';
        discrepancies.push({
            type: 'missing_payments',
            count: unpaidItems.length,
            itemIds: unpaidItems.map(i => i._id),
            description: `${unpaidItems.length} itens aprovados não constam no pagamento`
        });
    }
    
    return {
        status,
        expectedAmount,
        receivedAmount,
        difference,
        discrepancies,
        isComplete: status === 'completed',
        requiresAction: discrepancies.length > 0
    };
}

// ============================================
// BATCH CREATION
// ============================================

/**
 * Cria um novo lote de faturamento
 */
export async function createBatch(data, options = {}) {
    const {
        insuranceProvider,
        insuranceProviderCode,
        startDate,
        endDate,
        items = [],
        createdBy,
        metadata = {}
    } = data;
    
    // Gera número do lote
    const batchNumber = await generateBatchNumber(insuranceProvider);
    
    // Calcula totais
    const totalGross = items.reduce((sum, item) => sum + (item.grossAmount || 0), 0);
    
    const batch = {
        batchNumber,
        insuranceProvider,
        insuranceProviderCode,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        items: items.map(item => ({
            ...item,
            status: 'pending',
            attemptCount: 0
        })),
        totalItems: items.length,
        totalGross,
        pendingCount: items.length,
        status: 'pending',
        createdBy,
        metadata
    };
    
    return batch;
}

/**
 * Gera número sequencial do lote
 */
async function generateBatchNumber(insuranceProvider) {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    
    // Sequência diária (em produção, buscar do banco)
    const sequence = Math.floor(Math.random() * 9000) + 1000;
    
    return `${insuranceProvider.toUpperCase()}-${year}${month}${day}-${sequence}`;
}

// ============================================
// EXPORTS
// ============================================

export default {
    processInsuranceBatch,
    sendBatchToProvider,
    validateBatch,
    canAddItemToBatch,
    groupItemsByGuideType,
    calculateBatchMetrics,
    analyzeGlosa,
    reconcilePayment,
    createBatch
};
