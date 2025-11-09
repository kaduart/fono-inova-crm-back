import mongoose from "mongoose";

const followupSchema = new mongoose.Schema({
    lead: { type: mongoose.Schema.Types.ObjectId, ref: "Leads", required: true },
    message: { type: String, default: "" },
    stage: {
        type: String,
        enum: ['initial', 'follow_up', 'nurture', 'custom', 'primeiro_contato'], // ✅ ADICIONADO
        default: 'initial',
        index: true
    },

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

    // ✅ CORRIGIDO - ADICIONAR type: em todos os campos
    processingContext: {
        optimized: { type: Boolean },
        sentAtHour: { type: Number },
        weekday: { type: Number }
    },

    // Métricas clássicas
    responded: { type: Boolean, default: false },
    responseTimeMinutes: { type: Number },

    // Denormalização
    origin: { type: String },
    playbook: { type: String },
    note: { type: String }, // ✅ ADICIONADO (usado em createLeadFromAd)
    leadName: { type: String },
    leadPhoneE164: { type: String, index: true },
    wppMessageId: { type: String, index: true },
}, { timestamps: true });

// Índices
followupSchema.index({ status: 1, scheduledAt: 1 });
followupSchema.index({ lead: 1, createdAt: -1 });
followupSchema.index({ status: 1, scheduledAt: 1, retryCount: 1 });
followupSchema.index({ origin: 1, sentAt: -1 });
followupSchema.index({ playbook: 1, sentAt: -1 });
followupSchema.index({ lead: 1, responded: 1 }); // ✅ ADICIONADO (usado no responseTracking)

// Idempotência
followupSchema.index(
    { lead: 1, stage: 1, status: 1, scheduledAt: 1 },
    {
        partialFilterExpression: { status: { $in: ['scheduled', 'processing'] } }
    }
);

// Helpers para transições de estado
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