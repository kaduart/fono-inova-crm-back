import mongoose from 'mongoose';

/**
 * 📅 Log de execução do Calendário Temático GMB
 * 
 * Rastreia cada execução do cron diário:
 * - data da execução
 * - sucesso ou falha
 * - posts criados
 * - duração
 * - erros
 * - payload gerado
 * 
 * Permite auditoria, retry seguro e observabilidade.
 */

const gmbCalendarRunSchema = new mongoose.Schema({
  // Data da execução (YYYY-MM-DD) — única por dia
  date: {
    type: String,
    required: true,
    unique: true,
    index: true
  },

  // Dia do calendário utilizado (1-30)
  calendarDay: {
    type: Number,
    required: true,
    min: 1,
    max: 31
  },

  // Status geral da execução
  status: {
    type: String,
    enum: ['running', 'success', 'failed', 'skipped'],
    default: 'running',
    index: true
  },

  // Posts criados nesta execução
  postsCreated: [{
    postId: { type: mongoose.Schema.Types.ObjectId, ref: 'GmbPost' },
    tema: String,
    especialidadeId: String,
    url: String,
    funnelStage: String
  }],

  // Métricas
  durationMs: { type: Number, default: 0 },
  postsCount: { type: Number, default: 0 },

  // Erro, se houver
  error: {
    message: String,
    stack: String
  },

  // Payload resumido (copy gerado, imagem, etc.)
  payload: {
    tema: String,
    especialidadeId: String,
    url: String,
    funil: String,
    angulo: String,
    tipo: String
  },

  // Quem disparou (cron ou manual)
  triggeredBy: {
    type: String,
    enum: ['cron', 'manual'],
    default: 'cron'
  }

}, { timestamps: true });

// Índice para consultas recentes
gmbCalendarRunSchema.index({ createdAt: -1 });
gmbCalendarRunSchema.index({ status: 1, createdAt: -1 });

const GmbCalendarRun = mongoose.model('GmbCalendarRun', gmbCalendarRunSchema);

export default GmbCalendarRun;
