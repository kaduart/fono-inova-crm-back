// models/EvaluationReengagement.js
// "Retomar contato" com quem fez avaliação e não deu continuidade (Kadu, 12/11/2026).
// Um documento por avaliação: marca que a mensagem foi agendada/enviada para não repetir contato.
// Coleção própria: não altera Patient, Appointment nem Package. Ver docs/flows/evaluation_reengagement.md.
import mongoose from 'mongoose';

const evaluationReengagementSchema = new mongoose.Schema({
    evaluation: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', required: true },
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
    phone: { type: String, required: true }, // E.164 BR canônico (mesmo telefone = 1 mensagem)
    evaluatedAt: { type: Date, default: null },
    specialty: { type: String, default: null },
    queuedAt: { type: Date, default: null },
    queuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    scheduledFor: { type: Date, default: null }, // envio espalhado em dias úteis: quando sai
    sentAt: { type: Date, default: null },
    messageId: { type: String, default: null },
    error: { type: String, default: null },
    // Não enviado de propósito (a clínica conversou com a pessoa há pouco, inclusive na mão)
    skippedAt: { type: Date, default: null },
    skipReason: { type: String, default: null },
    lastClinicMessageAt: { type: Date, default: null },
}, { timestamps: true, collection: 'evaluation_reengagements' });

evaluationReengagementSchema.index({ evaluation: 1 }, { unique: true });
evaluationReengagementSchema.index({ patient: 1 });
evaluationReengagementSchema.index({ phone: 1 });
evaluationReengagementSchema.index({ queuedAt: 1 });
evaluationReengagementSchema.index({ scheduledFor: 1 });

export default mongoose.models.EvaluationReengagement
    || mongoose.model('EvaluationReengagement', evaluationReengagementSchema);
