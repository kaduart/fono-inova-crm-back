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
    liminarContract: { type: mongoose.Schema.Types.ObjectId, ref: 'LiminarContract', default: null },
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
        enum: ['pending', 'partial', 'paid', 'canceled', 'refunded', 'converted_to_package', 'recognized', 'consumed'],
        default: 'pending'
    },
    serviceType: { type: String, default: null },
    sessionType: { type: String, default: null },
    kind: {
        type: String,
        enum: ['package_receipt', 'revenue_recognition', 'session_payment', 'appointment_payment', 'package_consumed', 'monthly_settlement', 'debt_settlement', null],
        default: null
    },
    settledPaymentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Payment', default: [] }],
    billingType: {
        type: String,
        enum: ['particular', 'convenio', 'insurance', 'liminar'],
        required: false,
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
    parentPaymentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Payment',
        default: null,
        description: 'ID do payment original quando este for criado por remarcação'
    },
    isFromPackage: {
        type: Boolean,
        default: false,
        description: 'True quando o payment representa consumo de crédito de pacote (não é entrada de caixa)'
    },
    insurance: {
        provider: { type: String, default: null },
        authorizationCode: { type: String, default: null },
        status: {
            type: String,
            enum: ['pending', 'pending_billing', 'billed', 'received', 'rejected', null],
            default: 'pending'
        },
        grossAmount: { type: Number, default: 0 }
    },
    insuranceGuide: { type: mongoose.Schema.Types.ObjectId, ref: 'InsuranceGuide', default: null },
    insurancePlan:  { type: mongoose.Schema.Types.ObjectId, ref: 'InsurancePlan',  default: null },
    splitGroupId: {
        type: String,
        default: null,
        index: true,
        description: 'ID de grupo para vincular payments de um mesmo split (multi-forma)'
    },
    splitMethods: [{
        method: {
            type: String,
            enum: ['pix', 'cartão', 'dinheiro', 'bank_transfer', 'outro', 'credit_card', 'debit_card', 'other'],
        },
        amount: { type: Number, min: 0 }
    }],
    source: {
        type: String,
        default: null,
        description: 'Origem/fluxo que gerou o payment (ex: appointment_split, complete_session, manual_entry)'
    }
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
    
    // financialDate para payments pagos — paymentDate é predominante (data real do pagamento)
    if (['paid', 'completed', 'confirmed'].includes(this.status) && !this.financialDate && !this.isFromPackage) {
        this.financialDate = this.paymentDate || this.paidAt || new Date();
    }
    
    // 🚨 GUARDA FINANCEIRA: package_consumed SEMPRE é consumo de pacote
    if (this.kind === 'package_consumed' && !this.isFromPackage) {
        this.isFromPackage = true;
    }
    
    // 🚨 GUARDA FINANCEIRA: consumo de pacote NUNCA pode ter paidAt
    if ((this.isFromPackage || this.kind === 'package_consumed') && this.paidAt) {
        this.paidAt = null;
    }
    
    next();
});

// ============ BLINDAGEM FINANCEIRA ============
paymentSchema.pre('save', async function(next) {
    // 🎯 CAPTURA STATUS ANTES de qualquer modificação (para safety net post-save)
    if (!this.isNew && this.isModified('status')) {
        this.$locals.previousStatus = this.$locals.previousStatus || this._doc.status;
    }

    const ctx = FinancialContext.get();
    if (ctx === 'session' || ctx === 'appointment') {
        console.error(`[SECURITY BLOCK] Tentativa de save em Payment por ${ctx} bloqueada`);
        throw new Error(`[SECURITY] ${ctx} não pode criar/atualizar Payment diretamente`);
    }
    
    // 🚨 GUARDA FINANCEIRA: consumo de pacote NUNCA pode ter status 'paid' nem paidAt
    if ((this.isFromPackage || this.kind === 'package_consumed')) {
        if (this.status === 'paid') {
            this.status = 'consumed';
        }
        if (this.paidAt) {
            this.paidAt = null;
        }
    }
    
    if (this.status === 'paid' && !this.paidAt) {
        const error = new Error(
            `[FINANCIAL LOCK] paidAt é obrigatório quando status='paid'. `
        );
        error.code = 'MISSING_PAID_AT';
        return next(error);
    }
    
    if (['paid', 'completed', 'confirmed'].includes(this.status)) {
        if (!this.financialDate && !this.isFromPackage) {
            this.financialDate = this.createdAt || new Date();
        }
    }
    
    // 🚨 GUARDA FINANCEIRA: consumo de pacote NUNCA deve ter financialDate
    if (this.isFromPackage && this.financialDate) {
        const error = new Error(
            `[FINANCIAL_LOCK] Payment de consumo de pacote (isFromPackage=true) não pode ter financialDate. `
        );
        error.code = 'PACKAGE_PAYMENT_CANNOT_HAVE_FINANCIAL_DATE';
        return next(error);
    }
    
    // 🚨 GUARDA LEGADO: prepaid foi removido do domínio
    if (this.billingType === 'prepaid') {
        console.error('[FINANCIAL_GUARD] billingType=prepaid detectado — tipo removido do domínio', {
            paymentId: this._id,
            patient: this.patient,
            amount: this.amount
        });
        const error = new Error(`[FINANCIAL_LOCK] billingType='prepaid' foi removido do domínio. Use isFromPackage=true + paymentMethod='package'.`);
        error.code = 'PREPAID_BILLING_TYPE_DEPRECATED';
        return next(error);
    }
    
    next();
});

// ============ ÍNDICES DE PERFORMANCE (ledger multi-entry) ============
paymentSchema.index({ appointment: 1, splitGroupId: 1, status: 1 }, { name: 'ledger_split_lookup' });
paymentSchema.index({ source: 1, createdAt: -1 }, { name: 'source_audit_trail' });

// ============ SAFETY NET: Emite evento se status mudou via save() direto ============
// Detecta bypass de transitionPaymentStatus e emite evento automaticamente.
// O snapshot worker V2 tem idempotência via processedEvents, então duplicatas são seguras.
paymentSchema.post('save', async function(doc) {
    const previousStatus = doc.$locals?.previousStatus;
    const currentStatus = doc.status;

    if (!previousStatus || previousStatus === currentStatus) {
        return;
    }

    // Se transitionPaymentService já emitiu, pula
    if (doc.__statusChangedEmitted) {
        return;
    }

    try {
        await publishEvent(
            EventTypes.PAYMENT_STATUS_CHANGED,
            {
                paymentId: doc._id.toString(),
                patientId: doc.patient?.toString?.(),
                appointmentId: doc.appointment?.toString?.(),
                sessionId: doc.session?.toString?.(),
                packageId: doc.package?.toString?.(),
                from: previousStatus,
                to: currentStatus,
                amount: doc.amount,
                paymentMethod: doc.paymentMethod,
                financialDate: doc.financialDate,
                paidAt: doc.paidAt,
                kind: doc.kind,
                billingType: doc.billingType,
                isFromPackage: doc.isFromPackage,
                reason: 'post_save_safety_net',
                userId: null,
                _safetyNet: true  // marca como evento de segurança
            },
            {
                correlationId: `safety_net_${doc._id}_${previousStatus}_${currentStatus}_${Date.now()}`,
                idempotencyKey: `${doc._id}_${previousStatus}_${currentStatus}_${new Date().toISOString().split('T')[0]}`,
                aggregateType: 'payment',
                aggregateId: doc._id.toString(),
                metadata: { source: 'Payment.post_save_safety_net', autoEmitted: true }
            }
        );
        console.log(`[Payment Safety Net] ${doc._id}: ${previousStatus} → ${currentStatus} (evento emitido automaticamente)`);
    } catch (err) {
        console.error(`[Payment Safety Net] Falha ao emitir evento: ${err.message}`, {
            paymentId: doc._id,
            from: previousStatus,
            to: currentStatus
        });
    }
});

// ============ INDEXES PARA PERFORMANCE ============
paymentSchema.index({ status: 1, billingType: 1, paymentDate: -1 });
paymentSchema.index({ financialDate: -1, status: 1 });
paymentSchema.index({ patientId: 1, status: 1 });

// 💰 Índices para dashboards financeiros V2 (cash / production / receivables)
paymentSchema.index({ status: 1, financialDate: -1, amount: 1, kind: 1 }, { name: 'financial_cash_status_date' });
paymentSchema.index({ status: 1, doctor: 1, financialDate: -1 }, { name: 'financial_doctor_cash_status_date' });

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
