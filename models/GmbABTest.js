import mongoose from 'mongoose';

/**
 * 🧪 A/B Tests do Calendário Temático GMB
 * 
 * Rastreia performance das variantes A (educativo) e B (emocional/conversão)
 * por tema do calendário.
 */

const gmbABTestSchema = new mongoose.Schema({
  // Tema do calendário (ex: "crianca-2-anos-nao-fala")
  themeKey: {
    type: String,
    required: true,
    index: true
  },

  // Dia do calendário (1-30)
  calendarDay: {
    type: Number,
    required: true
  },

  // Variante: A ou B
  variant: {
    type: String,
    enum: ['A', 'B'],
    required: true
  },

  // Referência ao post do GMB
  postId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'GmbPost',
    required: true,
    index: true
  },

  // Copy / tema utilizado
  copyTheme: { type: String },

  // Métricas
  metrics: {
    views: { type: Number, default: 0 },
    whatsappClicks: { type: Number, default: 0 },
    leads: { type: Number, default: 0 }
  },

  // Data da execução
  date: {
    type: String,
    required: true,
    index: true
  }

}, { timestamps: true });

// Índice composto para análise de performance por tema + variante
gmbABTestSchema.index({ themeKey: 1, variant: 1 });
gmbABTestSchema.index({ date: 1, themeKey: 1 });

const GmbABTest = mongoose.model('GmbABTest', gmbABTestSchema);

export default GmbABTest;
