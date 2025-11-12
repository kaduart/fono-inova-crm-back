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
        type: String
    },
    valuePaid: {
        type: String
    },
    sessionType: {
        type: String
    },
    paymentType: {
        type: String
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
        required: false
    }],
    metrics: [{
        name: String,
        value: Number
    }],
    evaluationAreas: [{ // ✅ ADICIONAR ESTE CAMPO
        id: String,
        name: String,
        score: Number
    }],
    specialty: {
        type: String,
        required: true
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    content: {
        type: mongoose.Schema.Types.Mixed
    },
    observations: String,
    treatmentStatus: {
        type: String,
        enum: ['initial_evaluation', 'in_progress', 'improving', 'stable', 'regressing', 'completed'],
        default: 'in_progress'
    }
}, { timestamps: true });

const Evolution = mongoose.model('Evolution', evolutionSchema);
export default Evolution;