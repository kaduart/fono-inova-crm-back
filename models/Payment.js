import mongoose from 'mongoose';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import { FinancialContext } from '../utils/financialContext.js';
import { saveToOutbox } from '../infrastructure/outbox/outboxPattern.js';
import crypto from 'crypto';

const paymentSchema = new mongoose.Schema({
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
    doctor: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor' },
    appointment: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', default: null },
    session: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', default: null },
    package: { type: mongoose.Schema.Types.ObjectId, ref: 'Package', default: null },
    sessions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Session' }],
    advanceSessions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Session' }],
    amount: { type: Number, required: true, min: 0 },
    paymentDate: { type: Date, required: true },
    serviceDate: { type: Date, default: null },
    paymentMethod: {
        type: String,
        enum: ['pix', 'cartão', 'dinheiro', 'convenio', 'liminar_credit', 'credit_card', 'debit_card', 'cash', 'bank_transfer', 'other', 'credito', 'debito', 'cartao_credito', 'cartao_debito', 'transferencia', 'transferencia_bancaria'],
        required: true
    },
    status: {
        type: String,
        enum: ['pending', 'partial', 'paid', 'canceled', 'refunded', 'converted_to_package', 'recognized'],
        default: 'pending'
    },
    serviceType: { type: String, default: null },
    sessionType: { type: String, default: null },
    kind: {
        type: String,
        enum: ['package_receipt', 'revenue_recognition', 'session_payment', 'appointment_payment', null],
        default: null
    },
    billingType: {
        type: String,
        enum: ['particular', 'convenio', 'insurance', null],
        default: 'particular'
    },
    notes: { type: String, default: null },
    canceledAt: { type: Date, default: null },
    canceledReason: { type: String, default: null },
    // 🔄 Absorção de pagamento em pacote
    convertedAt: { type: Date, default: null },
    convertedPackage: { type: mongoose.Schema.Types.ObjectId, ref: 'Package', default: null },
    clinicId: { type: String, default: 'default' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // ✅ Data de confirmação do pagamento (quando efetivamente entrou no caixa)
    paidAt: { type: Date, default: null },
    confirmedAt: { type: Date, default: null },
}, { timestamps: true });

// ============ BLINDAGEM FINANCEIRA - PATCH DE SEGURANÇA ============
// Previne que Session ou Appointment atualizem diretamente o Payment
// Isso quebra o loop de decisões entre os modelos

paymentSchema.pre('findOneAndUpdate', async function(next) {
    const ctx = FinancialContext.get();
    if (ctx === 'session' || ctx === 'appointment') {
        console.error(`[SECURITY BLOCK] Tentativa de atualizar Payment por ${ctx} bloqueada`);
        console.error(`[SECURITY BLOCK] Query:`, this.getQuery());
        throw new Error(`[SECURITY] ${ctx} não pode atualizar Payment diretamente. Use o fluxo Payment → Session`);
    }
    
    // 🔒 FINANCIAL LOCK: Payment já pago não pode ser alterado (imutabilidade)
    const doc = await this.model.findOne(this.getQuery()).lean();
    if (doc?.status === 'paid') {
        // Permite apenas atualizações de campos não-financeiros (ex: notes, metadata)
        const update = this.getUpdate();
        const allowedFields = ['notes', 'metadata', 'updatedAt'];
        const updateFields = Object.keys(update.$set || update);
        
        const hasFinancialChange = updateFields.some(field => 
            !allowedFields.includes(field) && 
            !field.startsWith('$') // ignora operadores
        );
        
        if (hasFinancialChange) {
            const error = new Error(
                `[FINANCIAL LOCK] Payment já pago (id: ${doc._id}) não pode ser alterado. ` +
                `Campos financeiros são imutáveis. ` +
                `Para corrigir, crie um refund ou ajuste separado.`
            );
            error.code = 'PAYMENT_IMMUTABLE';
            return next(error);
        }
    }
    
    next();
});

paymentSchema.pre('updateOne', async function(next) {
    const ctx = FinancialContext.get();
    if (ctx === 'session' || ctx === 'appointment') {
        console.error(`[SECURITY BLOCK] Tentativa de updateOne em Payment por ${ctx} bloqueada`);
        throw new Error(`[SECURITY] ${ctx} não pode atualizar Payment diretamente`);
    }
    
    // 🔒 FINANCIAL LOCK: Verifica se está tentando alterar payment já pago
    const doc = await this.model.findOne(this.getQuery()).lean();
    if (doc?.status === 'paid') {
        const update = this.getUpdate();
        const allowedFields = ['notes', 'metadata', 'updatedAt'];
        const updateFields = Object.keys(update.$set || update);
        
        const hasFinancialChange = updateFields.some(field => 
            !allowedFields.includes(field) && !field.startsWith('$')
        );
        
        if (hasFinancialChange) {
            const error = new Error(
                `[FINANCIAL LOCK] Payment já pago (id: ${doc._id}) não pode ser alterado.`
            );
            error.code = 'PAYMENT_IMMUTABLE';
            return next(error);
        }
    }
    
    next();
});

paymentSchema.pre('save', function(next) {
    const ctx = FinancialContext.get();
    if (ctx === 'session' || ctx === 'appointment') {
        console.error(`[SECURITY BLOCK] Tentativa de save em Payment por ${ctx} bloqueada`);
        throw new Error(`[SECURITY] ${ctx} não pode criar/atualizar Payment diretamente`);
    }
    
    // 🔒 FINANCIAL LOCK: paidAt obrigatório quando status=paid
    if (this.status === 'paid' && !this.paidAt) {
        const error = new Error(
            `[FINANCIAL LOCK] paidAt é obrigatório quando status='paid'. ` +
            `Use: payment.paidAt = new Date() antes de salvar.`
        );
        error.code = 'MISSING_PAID_AT';
        return next(error);
    }
    
    // 🔒 TRAVA EXTRA: Se já estava pago, não pode alterar campos financeiros
    if (this.isModified() && !this.isNew) {
        const wasPaid = this._original?.status === 'paid' || 
                        this.$locals?.originalStatus === 'paid';
        
        if (wasPaid && this.isModified('status', 'amount', 'paidAt')) {
            const error = new Error(
                `[FINANCIAL LOCK] Payment já pago não pode ser alterado. ` +
                `Crie um refund ou ajuste separado.`
            );
            error.code = 'PAYMENT_IMMUTABLE';
            return next(error);
        }
    }
    
    next();
});

// ============ MÉTODO SEGURO PARA ATUALIZAÇÃO ============
// Única forma permitida de atualizar Payment de forma controlada

import { withFinancialContext } from '../utils/financialContext.js';

paymentSchema.statics.safeUpdate = async function(filter, update, options = {}) {
    return withFinancialContext('payment', async () => {
        return this.findOneAndUpdate(filter, update, { new: true, ...options });
    });
};

// ============ MÉTODO ATÔMICO COM OUTBOX ============
// Cria Payment e publica evento na MESMA TRANSACTION
// Garante: ou salva tudo, ou não salva nada

paymentSchema.statics.createWithEvent = async function(paymentData, eventData, mongoSession) {
    const ctx = FinancialContext.get();
    if (ctx !== 'payment' && ctx !== 'appointmentCompleteService') {
        throw new Error(`[SECURITY] createWithEvent só pode ser chamado de contexto payment. Contexto atual: ${ctx}`);
    }
    
    // 1. Cria o Payment
    const payment = new this(paymentData);
    await payment.save({ session: mongoSession });
    
    // 2. Salva evento no Outbox (mesma transaction!)
    const outboxEvent = {
        eventId: eventData.eventId || crypto.randomUUID(),
        eventType: eventData.eventType || 'PAYMENT_CREATED',
        correlationId: eventData.correlationId || paymentData.correlationId,
        payload: {
            paymentId: payment._id.toString(),
            patientId: paymentData.patient?.toString(),
            appointmentId: paymentData.appointment?.toString(),
            amount: paymentData.amount,
            status: paymentData.status,
            paidAt: paymentData.paidAt,
            ...eventData.payload
        },
        aggregateType: 'payment',
        aggregateId: payment._id.toString()
    };
    
    await saveToOutbox(outboxEvent, mongoSession);
    
    console.log(`[Payment.createWithEvent] Payment ${payment._id} + Evento ${outboxEvent.eventType} salvos atomicamente`);
    
    return payment;
};

paymentSchema.index({ paymentDate: 1, status: 1 });
paymentSchema.index({ patient: 1, paymentDate: -1 });
paymentSchema.index({ clinicId: 1, paymentDate: 1 });
paymentSchema.index({
    appointment: 1,
    status: 1
}, {
    unique: true,
    partialFilterExpression: {
        status: { $in: ['paid', 'pending'] },
        appointment: { $exists: true, $ne: null }
    }
});

paymentSchema.post('save', async function(doc) {
    try {
        const paymentDate = doc.paymentDate || new Date();
        const moment = (await import('moment-timezone')).default;
        const dateStr = moment.tz(paymentDate, 'America/Sao_Paulo').format('YYYY-MM-DD');

        await publishEvent(EventTypes.TOTALS_RECALCULATE_REQUESTED, {
            clinicId: doc.clinicId || 'default',
            date: dateStr,
            period: 'month',
            source: 'payment_saved'
        });
    } catch (err) {
        console.error('[Payment] Erro no post-save hook:', err.message);
    }
});

const Payment = mongoose.model('Payment', paymentSchema);

export default Payment;
