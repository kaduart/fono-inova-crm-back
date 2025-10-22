// models/Message.js
import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema({
    from: String,
    to: String,

    // quem enviou (inbound = paciente → clínica | outbound = clínica → paciente)
    direction: { type: String, enum: ['inbound', 'outbound'], required: true },

    // TIPOS SUPORTADOS
    type: {
        type: String,
        enum: ['text', 'template', 'image', 'audio', 'video', 'document', 'sticker'],
        default: 'text'
    },

    // texto visível no balão (ou legenda resumida do anexo)
    content: String,

    // 🔹 CAMPOS DE MÍDIA (novos)
    caption: String,          // legenda/filename (ex.: "[AUDIO]" ou caption da imagem)
    mediaUrl: String,         // URL lookaside vinda da Graph (o front passará pelo /api/proxy-media)

    templateName: String,

    status: { type: String, enum: ['sent', 'delivered', 'read', 'failed', 'received'], default: 'sent' },

    timestamp: { type: Date, default: Date.now },

    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' }
}, { timestamps: true });

// índice útil para histórico
messageSchema.index({ from: 1, to: 1, timestamp: 1 });

export default mongoose.model('Message', messageSchema);
