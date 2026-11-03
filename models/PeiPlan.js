// PEI — Plano de Ensino/Intervenção Individualizado (item 5 da sprint prontuário, 03/11/2026).
// Um plano ativo por paciente + profissional. Cada meta tem linha de base, alvo (0–10) e
// histórico de medições; o relatório mensal mostra o avanço. Ver docs/PEI.md.
import mongoose from 'mongoose';

const progressSchema = new mongoose.Schema({
    date: { type: Date, default: Date.now },
    value: { type: Number, min: 0, max: 10, required: true },
    note: { type: String, trim: true, maxlength: 500 },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { _id: false });

const goalSchema = new mongoose.Schema({
    area: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, required: true, trim: true, maxlength: 500 },
    // Como a meta é medida, em texto (ex.: "pede com frase de 2 palavras em 4 de 5 tentativas").
    criterion: { type: String, trim: true, maxlength: 300 },
    baseline: { type: Number, min: 0, max: 10, default: 0 },
    target: { type: Number, min: 0, max: 10, default: 10 },
    current: { type: Number, min: 0, max: 10 },
    status: { type: String, enum: ['active', 'achieved', 'paused'], default: 'active' },
    achievedAt: Date,
    history: { type: [progressSchema], default: [] },
});

const peiPlanSchema = new mongoose.Schema({
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
    doctor: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
    specialty: String,
    status: { type: String, enum: ['active', 'closed'], default: 'active' },
    startDate: { type: Date, default: Date.now },
    reviewDate: Date,
    notes: { type: String, trim: true, maxlength: 2000 },
    goals: { type: [goalSchema], default: [] },
    closedAt: Date,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

peiPlanSchema.index(
    { patient: 1, doctor: 1 },
    { unique: true, partialFilterExpression: { status: 'active' }, name: 'one_active_pei_per_doctor' }
);

export default mongoose.models.PeiPlan || mongoose.model('PeiPlan', peiPlanSchema);
