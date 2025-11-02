import mongoose from "mongoose";

const followupSchema = new mongoose.Schema({
    lead: { type: mongoose.Schema.Types.ObjectId, ref: "Leads", required: true },
    message: { type: String, default: "" },
    stage: { type: String, enum: ['initial', 'follow_up', 'nurture', 'custom'], default: 'initial', index: true },

    // Agendamento & processamento
    scheduledAt: { type: Date, required: true, index: true },
    processingAt: { type: Date },
    sentAt: { type: Date, index: true },
    respondedAt: { type: Date, index: true },
    failedAt: { type: Date },

    status: {
        type: String,
        enum: ["scheduled", "processing", "sent", "failed", "responded"],
        default: "scheduled",
        index: true
    },

    // Retries & diagnósticos
    retryCount: { type: Number, default: 0 },
    lastErrorAt: { type: Date },
    error: { type: String, default: null },

    // IA / conteúdo final enviado
    aiOptimized: { type: Boolean, default: false },
    finalMessage: { type: String },
    response: { type: mongoose.Schema.Types.Mixed },
    processingContext: {
        optimized: Boolean,
        sentAtHour: Number,
        weekday: Number
    },

    // Métricas clássicas (se você já usa)
    responded: { type: Boolean, default: false },
    responseTimeMinutes: { type: Number },

    // Opcional: denormalização p/ filtro rápido no backend
    origin: { type: String },
    playbook: { type: String },
    // Denormalizações úteis (snapshot no momento da criação/envio)
    leadName: { type: String },
    leadPhoneE164: { type: String, index: true },
    wppMessageId: { type: String, index: true },
}, { timestamps: true });

followupSchema.index({ status: 1, scheduledAt: 1 });
followupSchema.index({ lead: 1, createdAt: -1 });
followupSchema.index({ status: 1, scheduledAt: 1, retryCount: 1 });
// Para analytics rápidos
followupSchema.index({ origin: 1, sentAt: -1 });
followupSchema.index({ playbook: 1, sentAt: -1 });
// Idempotência: evita duplicar o MESMO stage para o mesmo lead dentro da janela de 24h
// (parcial: só aplica para scheduled/processing)
followupSchema.index(
    { lead: 1, stage: 1, status: 1, scheduledAt: 1 },
    {
        partialFilterExpression: { status: { $in: ['scheduled', 'processing'] } }
    });

// Helpers para transições de estado (centraliza regra de métrica)
followupSchema.methods.markProcessing = function () {
    this.status = 'processing';
    this.processingAt = new Date();
    return this.save();
};
followupSchema.methods.markSent = function () {
    this.status = 'sent';
    this.sentAt = new Date();
    return this.save();
};
followupSchema.methods.markFailed = function (errMsg = '') {
    this.status = 'failed';
    this.failedAt = new Date();
    this.lastErrorAt = new Date();
    this.error = errMsg?.slice(0, 800) || null;
    this.retryCount = (this.retryCount || 0) + 1;
    return this.save();
};
followupSchema.methods.markResponded = function () {
    this.status = 'responded';
    this.responded = true;
    this.respondedAt = new Date();
    if (this.sentAt) {
        this.responseTimeMinutes = Math.round((this.respondedAt - this.sentAt) / 60000);
    }
    return this.save();
};

export default mongoose.model("Followup", followupSchema);

