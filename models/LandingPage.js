/**
 * 🎯 Landing Page Model
 * Gerencia landing pages de alta conversão para a clínica
 */

import mongoose from 'mongoose';

const LandingPageSchema = new mongoose.Schema({
  // Identificação
  slug: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  
  // Dados principais
  title: {
    type: String,
    required: true
  },
  headline: {
    type: String,
    required: true
  },
  subheadline: String,
  
  // Categoria/Área
  category: {
    type: String,
    required: true,
    enum: ['fonoaudiologia', 'autismo', 'psicologia', 'aprendizagem', 'terapia_ocupacional', 'geografica', 'neuropsicologia', 'desenvolvimento']
  },
  
  // Keywords para SEO
  keywords: [String],
  
  // Sinais de alerta (bullet points)
  sinaisAlerta: [{
    icon: String,
    text: String
  }],
  
  // Conteúdo
  content: {
    quandoProcurar: String,
    comoFunciona: String,
    benefícios: [String]
  },
  
  // CTA
  cta: {
    text: { type: String, default: 'Agendar avaliação no WhatsApp' },
    link: { type: String, default: 'https://wa.me/5562993377726' },
    phone: { type: String, default: '62993377726' }
  },
  
  // SEO
  seo: {
    title: String,
    description: String,
    ogImage: String
  },
  
  // Status
  status: {
    type: String,
    enum: ['active', 'inactive', 'draft'],
    default: 'active'
  },
  
  // Métricas
  metrics: {
    views: { type: Number, default: 0 },
    leads: { type: Number, default: 0 },
    conversionRate: { type: Number, default: 0 }
  },
  
  // Para LPs geográficas
  location: {
    city: String,
    state: String
  },
  
  // Controle interno
  isDefault: { type: Boolean, default: false },
  priority: { type: Number, default: 0 }, // Para ordenar nas sugestões
  
  // Uso em posts
  lastUsedInPost: Date,
  postCount: { type: Number, default: 0 }
  
}, {
  timestamps: true
});

// Indexes
LandingPageSchema.index({ category: 1, status: 1 });
LandingPageSchema.index({ keywords: 1 });
LandingPageSchema.index({ priority: -1 });

// Métodos estáticos
LandingPageSchema.statics.findByCategory = function(category) {
  return this.find({ category, status: 'active' });
};

LandingPageSchema.statics.findRandomByCategory = async function(category, limit = 1) {
  const matchStage = category 
    ? { category, status: 'active' }
    : { status: 'active' };
    
  return this.aggregate([
    { $match: matchStage },
    { $sample: { size: limit } }
  ]);
};

LandingPageSchema.statics.getDailyRotation = async function() {
  // Retorna uma LP de cada categoria para rotação diária
  const categories = ['fonoaudiologia', 'autismo', 'psicologia', 'aprendizagem', 'terapia_ocupacional'];
  const dailyPages = [];
  
  for (const cat of categories) {
    const pages = await this.findRandomByCategory(cat, 1);
    if (pages.length > 0) {
      dailyPages.push(pages[0]);
    }
  }
  
  return dailyPages;
};

LandingPageSchema.statics.getSuggestedForPost = async function(category, excludeRecentlyUsed = true) {
  // Busca LPs que ainda não foram muito usadas em posts
  const query = { status: 'active' };
  
  if (category && category !== 'all') {
    query.category = category;
  }
  
  if (excludeRecentlyUsed) {
    // Exclui LPs usadas nos últimos 7 dias
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    query.$or = [
      { lastUsedInPost: { $exists: false } },
      { lastUsedInPost: { $lt: sevenDaysAgo } }
    ];
  }
  
  return this.find(query)
    .sort({ postCount: 1, priority: -1 })
    .limit(5);
};

// Método de instância para registrar uso em post
LandingPageSchema.methods.markUsedInPost = function() {
  this.lastUsedInPost = new Date();
  this.postCount += 1;
  return this.save();
};

const LandingPage = mongoose.model('LandingPage', LandingPageSchema);

export default LandingPage;
