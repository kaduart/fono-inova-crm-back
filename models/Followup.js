import mongoose from 'mongoose';

const followupSchema = new mongoose.Schema({
    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Leads', required: true },
    message: { type: String, required: true },
    scheduledAt: { type: Date, required: true },
    status: { type: String, enum: ['scheduled', 'sent', 'failed', 'canceled'], default: 'scheduled' },
    playbook: { type: String, enum: ['welcome', 'no_show', 'pacote_fim', 'reengajamento'], default: 'reengajamento' },
    channel: { type: String, enum: ["whatsapp", "instagram", "meta_ads", "google_ads", "indicação"], default: "whatsapp" },
    responded: { type: Boolean, default: false },
    responseTimeMinutes: { type: Number },
    sentiment: { type: String, enum: ["positivo", "neutro", "negativo"], default: "neutro" },
    engagementScore: { type: Number, default: 0 },
    stopReason: { type: String, default: null }, // Ex: "converted_to_appointment", "opt_out"
    error: { type: String, default: null },
}, { timestamps: true });

followupSchema.index({ scheduledAt: 1, status: 1 });

export default mongoose.model('Followup', followupSchema);
