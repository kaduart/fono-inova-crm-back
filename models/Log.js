import mongoose from 'mongoose';

const logSchema = new mongoose.Schema({
    type: {
        type: String,
        enum: [
            'followup',
            'whatsapp',
            'payment',
            'system',
            'pix',
            'email'
        ],
        default: 'system',
        index: true
    },
    referenceId: { type: mongoose.Schema.Types.ObjectId, refPath: 'refModel' },
    refModel: { type: String, enum: ['Followup', 'Lead', 'Payment'], default: 'Followup' },

    message: { type: String, required: true },
    data: { type: Object },
    status: { type: String, enum: ['success', 'warning', 'error'], default: 'success' },
    createdAt: { type: Date, default: Date.now }
});

export default mongoose.model('Log', logSchema);
