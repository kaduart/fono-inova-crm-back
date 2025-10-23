// models/Message.js
import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema({
    // Telefones sempre em E.164: +5562...
    from: { type: String, index: true, required: true },
    to: { type: String, index: true, required: true },

    // Direção
    direction: { type: String, enum: ['inbound', 'outbound'], required: true },

    // Tipos suportados
    type: {
        type: String,
        enum: ['text', 'template', 'image', 'audio', 'video', 'document', 'sticker'],
        default: 'text'
    },

    // Conteúdo renderizado (texto do balão ou legenda compacta)
    content: { type: String, default: '' },

    // Mídia
    caption: String,        // legenda/filename
    mediaUrl: String,       // link lookaside
    mediaId: String,        // id da mídia no Graph

    // Template (saída outbound)
    templateName: String,

    // Status
    status: { type: String, enum: ['sent', 'delivered', 'read', 'failed', 'received'], default: 'received' },

    // Quando ocorreu no WhatsApp
    timestamp: { type: Date, default: Date.now },

    // Referências úteis
    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
    contact: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact' },

    // Para triagem de mídia pela secretaria
    needs_human_review: { type: Boolean, default: false },

    // Raw payload p/ debug/auditoria
    raw: { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true });

// Índices úteis
messageSchema.index({ from: 1, to: 1, timestamp: 1 });
messageSchema.index({ lead: 1, timestamp: 1 });
messageSchema.index({ contact: 1, timestamp: 1 });

export default mongoose.model('Message', messageSchema);
