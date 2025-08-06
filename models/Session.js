// models/Session.js
import mongoose from 'mongoose';
import { syncEvent } from '../services/syncService.js';
import MedicalEvent from './MedicalEvent.js';

const sessionSchema = new mongoose.Schema({
    date: {
        type: String,
        /*  validate: {
             validator: function (date) {
                 if (!date) return true; // Permite null
 
                 const now = new Date();
                 return date >= new Date(now.setHours(0, 0, 0, 0));
             },
             message: "A data e hora do agendamento devem ser posteriores ao momento atual."
         } */
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
    confirmedAbsence: {
        type: Boolean,
        default: null,
        validate: {
            validator: function (value) {
                // Campo obrigatório apenas quando status é 'canceled'
                return this.status !== 'canceled' || value !== null;
            },
            message: 'confirmedAbsence é obrigatório para sessões canceladas'
        }
    },
    notes: { type: String },
}, {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
});

// Middlewares de sincronização
sessionSchema.post('save', async function (doc) {
    await syncEvent(doc, 'session');
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

// models/Session.js
/* sessionSchema.post('save', async function (doc, next) {
    try {
        const Package = mongoose.model('Package');
        const Appointment = mongoose.model('Appointment');

        // 1. Atualizar pacote se necessário
        if (doc.status === 'completed' && doc.package) {
            await Package.findByIdAndUpdate(
                doc.package,
                { $inc: { sessionsDone: 1 } }
            );
        }

        // 2. Sincronizar com Appointment APENAS se houver appointmentId
        if (doc.appointmentId) {
            const appointmentUpdate = {
                date: doc.date,
                doctor: doc.doctor,
                notes: doc.notes,
                sessionType: doc.sessionType
            };

            // Mapear status
            if (doc.status === 'completed') {
                appointmentUpdate.operationalStatus = 'pago';
                appointmentUpdate.clinicalStatus = 'concluído';
            } else if (doc.status === 'canceled') {
                appointmentUpdate.operationalStatus = 'cancelado';
                appointmentUpdate.clinicalStatus = 'faltou';
            } else {
                appointmentUpdate.operationalStatus = 'agendado';
                appointmentUpdate.clinicalStatus = 'pendente';
            }

            // Atualizar pagamento se aplicável
            if (doc.paymentMethod) {
                appointmentUpdate.paymentMethod = doc.paymentMethod;
            }

            // Atualizar sem disparar hooks para evitar loop
            await Appointment.findByIdAndUpdate(
                doc.appointmentId,
                appointmentUpdate,
                { runValidators: false, context: 'query' }
            );
        }

        next();
    } catch (error) {
        console.error('Erro no hook post-save da Session:', error);
        next(error);
    }
}); */


/* sessionSchema.pre('save', function (next) {
    if (this.status === 'completed' && !this.isPaid) {
        return res.status(400).json({ error: 'Sessão não pode ser marcada como concluída sem pagamento.' });
    }

    next();
}); */


const Session = mongoose.model('Session', sessionSchema);

export default Session;