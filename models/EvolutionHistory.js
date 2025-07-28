import mongoose from 'mongoose';

const evolutionHistorySchema = new mongoose.Schema({
    evolutionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Evolution', required: true },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    action: { type: String, enum: ['CREATE', 'UPDATE', 'DELETE'], required: true },
    previousData: { type: mongoose.Schema.Types.Mixed }, // Dados anteriores (usado para UPDATE e DELETE)
    createdAt: { type: Date, default: Date.now }
});

const EvolutionHistory = mongoose.model('EvolutionHistory', evolutionHistorySchema);
export default EvolutionHistory;
