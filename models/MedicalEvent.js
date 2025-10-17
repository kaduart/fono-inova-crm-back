// models/MedicalEvent.js
import mongoose from 'mongoose';

const medicalEventSchema = new mongoose.Schema({
    // Identificação
    type: {
        type: String,
        enum: ['session', 'package', 'evaluation', 'appointment'],
        required: true
    },
    originalId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true
    }, // ID do documento original

    // Temporal
    date: { type: Date, required: true },
    duration: { type: Number, default: 40 }, // minutos

    // Relacionamentos
    doctor: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Doctor',
        required: true
    },
    patient: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Patient',
        required: true
    },
    specialty: {
        type: String,
        enum: ['fonoaudiologia', 'psicologia', 'terapia_ocupacional', 'fisioterapia', 'pediatria', 'neuroped'],
        required: true
    },
    package: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Package'
    },

    // Financeiro
    value: {
        type: Number,
        required: true,
        min: 0,
        default: 200
    },
    paymentMethod: {
        type: String,
        enum: ['dinheiro', 'pix', 'cartão', null],
        default: null
    },
    isPaid: { type: Boolean, default: false },

    // Status
    operationalStatus: {
        type: String,
        enum: ['scheduled' | 'confirmed' | 'pending' | 'canceled' | 'paid' | 'missed'],
        default: 'agendado'
    },
    clinicalStatus: {
        type: String,
        enum: ['pending' | 'in_progress' | 'completed' | 'missed'],
        default: 'pendente'
    },
    version: {
        type: Number,
        default: 0
    },
    versionHistory: [{
        version: Number,
        updatedAt: Date,
        changes: mongoose.Schema.Types.Mixed
    }]
}, {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
});

const MedicalEvent = mongoose.model('MedicalEvent', medicalEventSchema);
export default MedicalEvent;