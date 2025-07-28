import mongoose from 'mongoose';

const evolutionSchema = new mongoose.Schema({
    patient: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Patient',
        required: true
    },
    doctor: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Doctor',
        required: true
    },
    date: {
        type: Date,
        required: true
    },
    time: {
        type: String // novo campo opcional (se quiser separar da data)
    },
    valuePaid: {
        type: String // novo campo opcional
    },
    sessionType: {
        type: String // novo campo opcional
    },
    paymentType: {
        type: String // novo campo opcional
    },
    appointmentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Appointment'
    },
    plan: {
        type: String,
        default: ""
    },
    pdfUrl: {
        type: String
    },
    evaluationTypes: [{
        type: String,
        enum: ['language', 'motor', 'cognitive', 'behavior', 'social'],
        required: false // <- ajustado para não ser obrigatório
    }],
    metrics: {
        type: Map,
        of: Number
    },
    specialty: { type: String, required: true },
    content: { type: mongoose.Schema.Types.Mixed },
    observations: String,
    treatmentStatus: {
        type: String,
        enum: ['initial_evaluation', 'in_progress', 'improving', 'stable', 'regressing', 'completed'],
        default: 'in_progress'
    }
}, { timestamps: true });


const Evolution = mongoose.model('Evolution', evolutionSchema);

export default Evolution;