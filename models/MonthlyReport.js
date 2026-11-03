// Relatório mensal do acompanhamento (item 3 da sprint prontuário, 03/11/2026).
// Um por paciente + profissional + mês. Números vêm só de evoluções FINALIZADAS.
// Fluxo: draft (gerado, terapeuta edita) → approved (terapeuta aprova) → sent (resumo na fila do WhatsApp).
// Ver docs/FAMILY_COMMUNICATION.md.
import mongoose from 'mongoose';

const monthlyReportSchema = new mongoose.Schema({
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
    doctor: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
    specialty: String,
    month: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
    status: { type: String, enum: ['draft', 'approved', 'sent'], default: 'draft' },
    // Fotografia dos números no momento da geração (sessões, presença, áreas, metas do PEI).
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Texto do terapeuta
    summary: { type: String, default: '' },
    nextSteps: { type: String, default: '' },
    familyMessage: { type: String, default: '' },
    generatedAt: Date,
    approvedAt: Date,
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    sentAt: Date,
    phoneLast4: String,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

monthlyReportSchema.index({ patient: 1, doctor: 1, month: 1 }, { unique: true, name: 'unique_monthly_report' });
monthlyReportSchema.index({ doctor: 1, month: 1, status: 1 });

export default mongoose.models.MonthlyReport || mongoose.model('MonthlyReport', monthlyReportSchema);
