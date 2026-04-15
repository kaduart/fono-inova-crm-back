/**
 * ChatProjection — Read Model (CQRS)
 *
 * Projeção otimizada para leitura do inbox do chat.
 * Atualizada assincronamente pelo chatProjectionWorker.
 *
 * NUNCA escrever diretamente nesta coleção via controller.
 * Toda escrita vem via eventos (MESSAGE_PERSISTED, WHATSAPP_MESSAGE_SENT).
 */

import mongoose from 'mongoose';

const ChatProjectionSchema = new mongoose.Schema(
  {
    leadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Lead',
      required: true,
      unique: true,
    },
    contactId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Contacts',
      default: null,
    },
    phone: {
      type: String,
      default: null,
    },
    contactName: {
      type: String,
      default: null,
    },
    lastMessage: {
      type: String,
      default: '',
      maxlength: 200,
    },
    lastMessageAt: {
      type: Date,
      default: null,
    },
    lastDirection: {
      type: String,
      enum: ['inbound', 'outbound'],
      default: 'inbound',
    },
    lastMessageType: {
      type: String,
      default: 'text',
    },
    unreadCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    assignedAgentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
    collection: 'chat_projections',
  }
);

// Índices para leitura rápida do inbox
ChatProjectionSchema.index({ lastMessageAt: -1 });    // ordenação do inbox
ChatProjectionSchema.index({ phone: 1 });              // lookup por telefone
ChatProjectionSchema.index({ unreadCount: -1 });       // filtro "não lidos"
ChatProjectionSchema.index({ assignedAgentId: 1, lastMessageAt: -1 }); // inbox por agente

export default mongoose.model('ChatProjection', ChatProjectionSchema);
