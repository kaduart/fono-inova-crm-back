// projections/financialProjection.js
/**
 * 💰 FINANCIAL PROJECTION - SIMPLIFICADA
 * 
 * Funções para atualizar e ler dados pré-calculados.
 * Chamada diretamente pelos workers (não via subscription).
 */

import FinancialProjection from '../models/FinancialProjection.js';

class FinancialProjectionHandler {
    
    /**
     * 🚀 Atualiza caixa quando payment é processado
     * Chamada diretamente pelo PaymentWorker
     */
    static async updateCash(paymentData) {
        const { amount, billingType = 'particular', paymentMethod, paymentId } = paymentData;
        
        try {
            const mes = new Date().toISOString().slice(0, 7); // "2026-04"
            
            await FinancialProjection.findOneAndUpdate(
                { month: mes, type: 'cash' },
                {
                    $inc: {
                        'data.total': amount,
                        [`data.byBillingType.${billingType}`]: amount,
                        [`data.byMethod.${paymentMethod || 'pix'}`]: amount,
                        'metadata.count': 1
                    },
                    $set: {
                        'metadata.lastPaymentAt': new Date(),
                        'metadata.lastPaymentId': paymentId
                    }
                },
                { upsert: true, new: true }
            );
            
            console.log(`[FinancialProjection] Caixa +R$${amount} (${billingType})`);
        } catch (error) {
            console.error('[FinancialProjection] Erro:', error);
        }
    }
    
    /**
     * 📊 Query otimizada para dashboard
     */
    static async getDashboardData(month) {
        const projection = await FinancialProjection.findOne({
            month,
            type: 'cash'
        }).lean();
        
        return {
            caixa: projection?.data?.total || 0,
            caixaDetalhe: {
                particular: projection?.data?.byBillingType?.particular || 0,
                convenio: projection?.data?.byBillingType?.convenio || 0
            },
            metadata: {
                ultimoPagamento: projection?.metadata?.lastPaymentAt,
                quantidade: projection?.metadata?.count || 0
            }
        };
    }
    
    /**
     * 🎯 Inicialização (placeholder - não usa subscription)
     */
    static start() {
        console.log('[FinancialProjection] Inicializada (modo manual)');
    }
}

export default FinancialProjectionHandler;
