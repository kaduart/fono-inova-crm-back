// services/paymentService.js
/**
 * 🎯 PAYMENT SERVICE - ÚNICA FONTE DE VERDADE
 * 
 * Regra de Ouro: NUNCA crie Payment diretamente.
 * SEMPRE use este service.
 * 
 * Garantias:
 * - Schema consistente
 * - Campos obrigatórios preenchidos
 * - Auditoria automática
 * - Validações de negócio
 */

import Payment from '../models/Payment.js';

class PaymentService {
    
    /**
     * 🏭 Cria um Payment padronizado (única forma permitida)
     * 
     * @param {Object} data - Dados do pagamento
     * @param {string} data.patientId - ID do paciente (obrigatório)
     * @param {string} data.appointmentId - ID do agendamento (opcional)
     * @param {number} data.amount - Valor (obrigatório, > 0)
     * @param {string} data.paymentMethod - Método (obrigatório)
     * @param {string} data.billingType - 'particular' | 'convenio' | 'insurance'
     * @param {string} data.status - 'pending' | 'paid' | 'partial' | etc
     * @param {Date} data.paymentDate - Data do pagamento
     * @param {Object} context - Contexto (source, userId, etc)
     * @returns {Promise<Payment>} Payment criado e validado
     */
    static async create(data, context = {}) {
        const { 
            patientId, 
            appointmentId, 
            amount, 
            paymentMethod = 'pix',
            billingType = 'particular',
            status = 'pending',
            paymentDate = new Date(),
            ...rest 
        } = data;
        
        // 🛡️ VALIDAÇÕES RIGOROSAS (fail fast)
        if (!patientId) throw new Error('[PaymentService] patientId obrigatório');
        if (!amount || amount <= 0) throw new Error('[PaymentService] amount deve ser > 0');
        if (!['particular', 'convenio', 'insurance'].includes(billingType)) {
            throw new Error(`[PaymentService] billingType inválido: ${billingType}`);
        }
        
        // 📋 SCHEMA PADRONIZADO (única fonte de verdade)
        const paymentData = {
            // Referências (ObjectId + String para compatibilidade)
            patient: patientId,
            patientId: patientId.toString(),
            
            ...(appointmentId && {
                appointment: appointmentId,
                appointmentId: appointmentId.toString()
            }),
            
            // Dados financeiros
            amount: Number(amount),
            paymentMethod,
            billingType,  // 🎯 SEMPRE preenchido
            status,
            
            // Datas (fonte única de verdade)
            paymentDate: new Date(paymentDate),
            financialDate: status === 'paid' ? new Date() : null,
            
            // Metadata
            source: context.source || 'api',
            createdBy: context.userId || null,
            
            // Restante dos dados
            ...rest
        };
        
        // 💾 Criação com validação completa
        const payment = new Payment(paymentData);
        await payment.save();
        
        console.log(`[PaymentService] Criado: ${payment._id} | ${billingType} | ${status} | R$${amount}`);
        
        return payment;
    }
    
    /**
     * 💰 Marca como pago (única forma permitida de atualizar status)
     * 
     * @param {string} paymentId - ID do payment
     * @param {Object} dados - { paymentMethod, paidAt, userId }
     * @returns {Promise<Payment>} Payment atualizado
     */
    static async markAsPaid(paymentId, dados = {}) {
        const { paymentMethod, paidAt = new Date(), userId } = dados;
        
        const update = {
            status: 'paid',
            paidAt: new Date(paidAt),
            confirmedAt: new Date(),
            financialDate: new Date(paidAt),  // 🎯 Fonte única de verdade
            ...(paymentMethod && { paymentMethod }),
            ...(userId && { confirmedBy: userId })
        };
        
        const payment = await Payment.findByIdAndUpdate(
            paymentId,
            { $set: update },
            { new: true }
        );
        
        if (!payment) throw new Error(`[PaymentService] Payment não encontrado: ${paymentId}`);
        
        console.log(`[PaymentService] Pago: ${paymentId} | R$${payment.amount}`);
        
        return payment;
    }
    
    /**
     * 🔍 Valida consistência de um payment (auditoria)
     * 
     * @param {string} paymentId 
     * @returns {Object} { valido: boolean, erros: string[] }
     */
    static async audit(paymentId) {
        const payment = await Payment.findById(paymentId).lean();
        
        if (!payment) return { valido: false, erros: ['Payment não encontrado'] };
        
        const erros = [];
        
        // Check campos obrigatórios
        if (!payment.patient) erros.push('patient ausente');
        if (!payment.billingType) erros.push('billingType ausente');
        if (!payment.paymentDate) erros.push('paymentDate ausente');
        
        // Check consistência
        if (payment.status === 'paid') {
            if (!payment.paidAt) erros.push('paid é obrigatório quando status=paid');
            if (!payment.financialDate) erros.push('financialDate ausente em payment pago');
        }
        
        // Check valores
        if (payment.amount <= 0) erros.push('amount deve ser > 0');
        
        return {
            valido: erros.length === 0,
            erros,
            payment: payment._id
        };
    }
    
    /**
     * 🧹 Auditoria em massa (roda periodicamente)
     * 
     * @param {Date} since - Data inicial para verificar
     * @returns {Object} { total, validos, invalidos, corrigidos }
     */
    static async auditMass(since = new Date(Date.now() - 24 * 60 * 60 * 1000)) {
        const payments = await Payment.find({
            createdAt: { $gte: since }
        }).lean();
        
        let validos = 0;
        let invalidos = 0;
        let corrigidos = 0;
        
        for (const p of payments) {
            const audit = await this.audit(p._id);
            
            if (audit.valido) {
                validos++;
            } else {
                invalidos++;
                console.warn(`[PaymentService][AUDIT] ${p._id}: ${audit.erros.join(', ')}`);
                
                // Auto-corrige se possível
                if (audit.erros.includes('billingType ausente')) {
                    await Payment.updateOne(
                        { _id: p._id },
                        { $set: { billingType: 'particular' } }
                    );
                    corrigidos++;
                }
            }
        }
        
        console.log(`[PaymentService][AUDIT] Total: ${payments.length} | ✅ ${validos} | ❌ ${invalidos} | 🔧 ${corrigidos}`);
        
        return { total: payments.length, validos, invalidos, corrigidos };
    }
}

export default PaymentService;
