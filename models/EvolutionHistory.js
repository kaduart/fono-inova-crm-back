import mongoose from 'mongoose';

const evolutionHistorySchema = new mongoose.Schema({
    evolutionId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Evolution',
        required: true,
        index: true
    },
    changedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    action: {
        type: String,
        enum: ['CREATE', 'UPDATE', 'DELETE', 'PLAN_CHANGE', 'STATUS_CHANGE'],
        required: true
    },
    previousData: {
        type: mongoose.Schema.Types.Mixed
    },
    newData: {
        type: mongoose.Schema.Types.Mixed
    },
    changes: [{
        field: String,
        oldValue: mongoose.Schema.Types.Mixed,
        newValue: mongoose.Schema.Types.Mixed
    }],
    reason: String,
    ipAddress: String,
    userAgent: String
}, {
    timestamps: true
});

// Índices para auditoria
evolutionHistorySchema.index({ evolutionId: 1, createdAt: -1 });
evolutionHistorySchema.index({ changedBy: 1 });
evolutionHistorySchema.index({ action: 1 });
evolutionHistorySchema.index({ createdAt: -1 });

const EvolutionHistory = mongoose.model('EvolutionHistory', evolutionHistorySchema);
export default EvolutionHistory;