import mongoose from 'mongoose';

const FinancialGoalSchema = new mongoose.Schema({
    clinicId: { type: String, required: true, default: 'default' },

    month: { type: Number, required: true },
    year: { type: Number, required: true },

    metaMensal: { type: Number, default: 0 },

    breakdown: {
        particular: { type: Number, default: 0 },
        convenio: { type: Number, default: 0 },
        pacote: { type: Number, default: 0 },
        liminar: { type: Number, default: 0 }
    },

    diasUteis: { type: Number, default: 26 },

    active: { type: Boolean, default: true }
}, {
    timestamps: true
});

// Índice único por clínica + mês + ano
FinancialGoalSchema.index({ clinicId: 1, year: 1, month: 1 }, { unique: true });

export default mongoose.model('FinancialGoal', FinancialGoalSchema);
