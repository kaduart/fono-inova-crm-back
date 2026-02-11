// models/Session.js
import mongoose from 'mongoose';
import { syncEvent } from '../services/syncService.js';
import MedicalEvent from './MedicalEvent.js';

const sessionSchema = new mongoose.Schema({
    date: {
        type: String,
    },
    time: String,
    sessionType: {
        type: String,
    },
    sessionValue: Number,
    appointmentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Appointment',
        default: null,
        required: false
    },
    doctor: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Doctor', // String, não importe o modelo aqui!
        required: true
    },
    patient: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Patient',
        required: true
    },
    package: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Package', // String
    },
    isPaid: { type: Boolean, default: false },
    paymentMethod: {
        type: String,
        enum: ['dinheiro', 'pix', 'cartão'],
        default: null
    },
    session: String,
    status: {
        type: String,
        enum: {
            values: ['pending', 'completed', 'canceled', 'scheduled'],
            message: 'Status inválido para sessão'
        },
    },
    confirmedAbsence: { type: Boolean, default: null },
    notes: { type: String },
    paymentStatus: {
        type: String,
        enum: ['paid', 'partial', 'pending'],
        default: 'pending',
        description: 'Situação financeira específica desta sessão'
    },

    partialAmount: {
        type: Number,
        default: 0,
        description: 'Valor pago parcialmente nesta sessão (se aplicável)'
    },

    visualFlag: {
        type: String,
        enum: ['ok', 'pending', 'blocked'],
        default: 'pending',
        description: 'Indica o estado visual da sessão para exibição no calendário'
    },
    originalPartialAmount: {
        type: Number,
        description: 'Valor original pago antes do cancelamento'
    },
    originalPaymentStatus: {
        type: String,
        enum: ['paid', 'partial', 'pending'],
        description: 'Status de pagamento original'
    },
    originalPaymentMethod: {
        type: String,
        enum: ['dinheiro', 'pix', 'cartão'],
        description: 'Método de pagamento original'
    },
    originalIsPaid: {
        type: Boolean,
        description: 'Flag de pagamento original'
    },
    canceledAt: {
        type: Date,
        description: 'Data do cancelamento'
    }

}, {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
});

// Hook pós-save para provisionamento automático
sessionSchema.post('findOneAndUpdate', async function (doc) {
    if (doc && doc.status === 'completed') {
        // Verifica se já não foi provisionado
        const foiProvisionado = doc.wasProvisioned;

        if (!foiProvisionado) {
            try {
                await provisionamentoService.realizarSessao(doc._id, new Date());

                // Marcar como provisionado para não duplicar
                await mongoose.model('Session').updateOne(
                    { _id: doc._id },
                    { $set: { wasProvisioned: true } }
                );
            } catch (err) {
                console.error('Erro ao provisionar sessão:', err);
            }
        }
    }
});

sessionSchema.post('findOneAndUpdate', async function (doc) {
    if (doc) await syncEvent(doc, 'session');
});

sessionSchema.post('findOneAndDelete', async function (doc) {
    if (doc) {
        await MedicalEvent.deleteOne({
            originalId: doc._id,
            type: 'session'
        });
    }
});

sessionSchema.post('save', async function (doc) {
    // 🚫 Evita sincronização redundante durante fluxos financeiros
    if (doc._inFinancialTransaction) return;
    await syncEvent(doc, 'session');
});

sessionSchema.add({
    wasProvisioned: { type: Boolean, default: false },
    dataRealizacao: { type: Date }
});

const Session = mongoose.model('Session', sessionSchema);

export default Session;