import mongoose from 'mongoose';

/**
 * 🏥 Convenio Model
 * 
 * Armazena os valores de reembolso/faturamento por convênio.
 * Usado para calcular receita esperada de sessões de convênio.
 */
const convenioSchema = new mongoose.Schema({
  // Identificação
  code: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  
  name: {
    type: String,
    required: true,
    trim: true
  },
  
  // Valor de reembolso por sessão
  sessionValue: {
    type: Number,
    required: true,
    min: 0,
    default: 0
  },
  
  // Status
  active: {
    type: Boolean,
    default: true
  },
  
  // Observações
  notes: {
    type: String,
    default: ''
  }

}, {
  timestamps: true
});

// Índices
convenioSchema.index({ code: 1 });
convenioSchema.index({ active: 1 });

// Método estático para obter valor por código
convenioSchema.statics.getSessionValue = async function(code) {
  const convenio = await this.findOne({ code: code.toLowerCase(), active: true });
  return convenio?.sessionValue || 0;
};

// Método estático para inicializar convênios padrão
convenioSchema.statics.initializeDefaults = async function() {
  const defaults = [
    { code: 'unimed-anapolis', name: 'Unimed Anápolis', sessionValue: 80 },
    { code: 'unimed-campinas', name: 'Unimed Campinas', sessionValue: 140 },
    { code: 'unimed-goiania', name: 'Unimed Goiânia', sessionValue: 80 }
  ];
  
  for (const conv of defaults) {
    await this.findOneAndUpdate(
      { code: conv.code },
      conv,
      { upsert: true, new: true }
    );
  }
  
  console.log('✅ Convênios padrão inicializados');
};

const Convenio = mongoose.model('Convenio', convenioSchema);

export default Convenio;
