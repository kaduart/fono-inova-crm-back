// models/AmandaAgentShadow.js
// Respostas sugeridas pelo agente Claude em modo sombra (AMANDA_AGENT_MODE=shadow).
// Nada aqui é enviado à família: serve para comparar com a resposta da FSM atual.
import mongoose from 'mongoose';

const amandaAgentShadowSchema = new mongoose.Schema(
  {
    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', index: true },
    phone: String,
    correlationId: String,
    input: String,
    fsmReply: String,
    fsmCommand: String,
    agentReply: String,
    agentCommand: String,
    toolCalls: { type: mongoose.Schema.Types.Mixed, default: [] },
    handoff: { type: mongoose.Schema.Types.Mixed, default: null },
    usage: { type: mongoose.Schema.Types.Mixed, default: null },
    model: String,
    ms: Number,
    error: String,
    // avaliação manual da equipe (preenchida depois)
    review: {
      better: { type: String, enum: ['agent', 'fsm', 'tie', null], default: null },
      note: String,
      reviewedAt: Date,
    },
  },
  { timestamps: true },
);

// guarda 90 dias
amandaAgentShadowSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

export default mongoose.models.AmandaAgentShadow || mongoose.model('AmandaAgentShadow', amandaAgentShadowSchema);
