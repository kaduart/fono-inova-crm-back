import mongoose from 'mongoose';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import { FinancialContext } from '../utils/financialContext.js';

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

paymentSchema.pre('findOneAndUpdate', function(next) {
    const ctx = FinancialContext.get();
    if (ctx === 'session' || ctx === 'appointment') {
        console.error(`[SECURITY BLOCK] Tentativa de atualizar Payment por ${ctx} bloqueada`);
        console.error(`[SECURITY BLOCK] Query:`, this.getQuery());
        throw new Error(`[SECURITY] ${ctx} não pode atualizar Payment diretamente. Use o fluxo Payment → Session`);
    }
    next();
});

paymentSchema.pre('updateOne', function(next) {
    const ctx = FinancialContext.get();
    if (ctx === 'session' || ctx === 'appointment') {
        console.error(`[SECURITY BLOCK] Tentativa de updateOne em Payment por ${ctx} bloqueada`);
        throw new Error(`[SECURITY] ${ctx} não pode atualizar Payment diretamente`);
    }
    next();
});

paymentSchema.pre('save', function(next) {
    const ctx = FinancialContext.get();
    if (ctx === 'session' || ctx === 'appointment') {
        console.error(`[SECURITY BLOCK] Tentativa de save em Payment por ${ctx} bloqueada`);
        throw new Error(`[SECURITY] ${ctx} não pode criar/atualizar Payment diretamente`);
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
