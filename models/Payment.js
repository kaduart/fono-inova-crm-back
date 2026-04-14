import mongoose from 'mongoose';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import { FinancialContext } from '../utils/financialContext.js';
import { saveToOutbox } from '../infrastructure/outbox/outboxPattern.js';
import crypto from 'crypto';

const paymentSchema = new mongoose.Schema({
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
    patientId: { type: String, index: true }, // 🎯 Compatibilidade V2
    doctor: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor' },
    appointment: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', default: null },
    appointmentId: { type: String, index: true }, // 🎯 Compatibilidade V2
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
        enum: ['particular', 'convenio', 'insurance', 'liminar', null],
        default: 'particular'
    },
    notes: { type: String, default: null },
    canceledAt: { type: Date, default: null },
    canceledReason: { type: String, default: null },
    convertedAt: { type: Date, default: null },
    convertedPackage: { type: mongoose.Schema.Types.ObjectId, ref: 'Package', default: null },
    clinicId: { type: String, default: 'default' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    paidAt: { type: Date, default: null },
    confirmedAt: { type: Date, default: null },
    financialDate: { type: Date, default: null, index: true },
}, { timestamps: true });

// ============ SCHEMA GUARD - PROTEÇÃO CONSISTÊNCIA ============
paymentSchema.pre('validate', function(next) {
    // 🎯 AUTO-PREENCHIMENTO: Garante consistência
    
    // billingType SEMPRE deve existir
    if (!this.billingType) {
        this.billingType = 'particular';
    }
    
    // patientId sempre string do patient
    if (this.patient && !this.patientId) {
        this.patientId = this.patient.toString();
    }
    
    // appointmentId sempre string do appointment
    if (this.appointment && !this.appointmentId) {
        this.appointmentId = this.appointment.toString();
    }
    
    // financialDate para payments pagos
    if (['paid', 'completed', 'confirmed'].includes(this.status) && !this.financialDate) {
        this.financialDate = this.paidAt || this.paymentDate || new Date();
    }
    
    next();
});

// ============ BLINDAGEM FINANCEIRA ============
paymentSchema.pre('save', async function(next) {
    const ctx = FinancialContext.get();
    if (ctx === 'session' || ctx === 'appointment') {
        console.error(`[SECURITY BLOCK] Tentativa de save em Payment por ${ctx} bloqueada`);
        throw new Error(`[SECURITY] ${ctx} não pode criar/atualizar Payment diretamente`);
    }
    
    if (this.status === 'paid' && !this.paidAt) {
        const error = new Error(
            `[FINANCIAL LOCK] paidAt é obrigatório quando status='paid'. `
        );
        error.code = 'MISSING_PAID_AT';
        return next(error);
    }
    
    if (['paid', 'completed', 'confirmed'].includes(this.status)) {
        if (!this.financialDate) {
            this.financialDate = this.createdAt || new Date();
        }
    }
    
    next();
});

// ============ INDEXES PARA PERFORMANCE ============
paymentSchema.index({ status: 1, billingType: 1, paymentDate: -1 });
paymentSchema.index({ financialDate: -1, status: 1 });
paymentSchema.index({ patientId: 1, status: 1 });

// ============ MÉTODOS ============
paymentSchema.methods.toDTO = function() {
    return {
        id: this._id,
        patientId: this.patientId || this.patient?.toString(),
        appointmentId: this.appointmentId || this.appointment?.toString(),
        amount: this.amount,
        status: this.status,
        billingType: this.billingType,
        paymentMethod: this.paymentMethod,
        paymentDate: this.paymentDate,
        financialDate: this.financialDate,
        paidAt: this.paidAt
    };
};

const Payment = mongoose.model('Payment', paymentSchema);

export default Payment;
