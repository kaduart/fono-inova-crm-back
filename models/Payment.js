import mongoose from 'mongoose';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';

const paymentSchema = new mongoose.Schema({
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
    appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' },
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Session' },
    packageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Package' },
    amount: { type: Number, required: true, min: 0 },
    receivedAmount: { type: Number, default: 0, min: 0 },
    paymentDate: { type: Date, required: true },
    paymentMethod: { type: String, enum: ['pix', 'credit_card', 'debit_card', 'cash', 'bank_transfer', 'other'], required: true },
    status: { type: String, enum: ['pending', 'partial', 'paid', 'canceled', 'refunded'], default: 'pending' },
    billingType: { type: String, enum: ['particular', 'convenio', 'insurance'], default: 'particular' },
    clinicId: { type: String, default: 'default' },
    description: { type: String },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    relatedExpenseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Expense' },
    source: { type: String, enum: ['appointment', 'package', 'session', 'manual'], default: 'manual' },
    isFromPackage: { type: Boolean, default: false },
}, { timestamps: true });

// Index para queries de período
paymentSchema.index({ paymentDate: 1, status: 1 });
paymentSchema.index({ clinicId: 1, paymentDate: 1 });

// 🛡️ IDEMPOTÊNCIA: Índice único para evitar duplicidade de pagamentos
// Um appointment só pode ter um pagamento do tipo 'appointment'
// (package e manual podem ter múltiplos)
paymentSchema.index({ 
    appointment: 1, 
    source: 1 
}, { 
    unique: true, 
    partialFilterExpression: { 
        source: 'appointment',
        appointment: { $exists: true, $ne: null }
    }
});

// Post-save hook para disparar recálculo - definido no SCHEMA antes de criar model
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

// Cria o model DEPOIS de definir os hooks
const Payment = mongoose.model('Payment', paymentSchema);

export default Payment;
