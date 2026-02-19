// models/InsuranceGuide.js
import mongoose from 'mongoose';

/**
 * 🏥 InsuranceGuide Model
 *
 * Representa uma guia de convênio autorizada para um paciente.
 * Funciona como um "pacote do convênio" com quantidade fixa de sessões.
 *
 * Fluxo de consumo:
 * 1. Guia criada com totalSessions (ex: 10)
 * 2. Cada agendamento incrementa usedSessions
 * 3. Quando usedSessions === totalSessions, status vira 'exhausted'
 * 4. Se passar de expiresAt, status vira 'expired' (via job/query)
 */
const insuranceGuideSchema = new mongoose.Schema({
  // ======================================================================
  // IDENTIFICAÇÃO
  // ======================================================================

  number: {
    type: String,
    required: [true, 'Número da guia é obrigatório'],
    unique: true,
    trim: true,
    uppercase: true,
    index: true
  },

  patientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Patient',
    required: [true, 'Paciente é obrigatório'],
    index: true
  },

  specialty: {
    type: String,
    required: [true, 'Especialidade é obrigatória'],
    lowercase: true,
    trim: true,
    enum: {
      values: [
        'fonoaudiologia',
        'psicologia',
        'fisioterapia',
        'psicomotricidade',
        'musicoterapia',
        'psicopedagogia',
        'terapia_ocupacional',
        'neuropsicologia'

      ],
      message: 'Especialidade "{VALUE}" não é válida'
    }
  },

  insurance: {
    type: String,
    required: [true, 'Convênio é obrigatório'],
    lowercase: true,
    trim: true
  },

  // ======================================================================
  // CONTROLE DE SESSÕES
  // ======================================================================

  totalSessions: {
    type: Number,
    required: [true, 'Total de sessões é obrigatório'],
    min: [1, 'Guia deve ter ao menos 1 sessão'],
    validate: {
      validator: Number.isInteger,
      message: 'Total de sessões deve ser um número inteiro'
    }
  },

  usedSessions: {
    type: Number,
    default: 0,
    min: [0, 'Sessões utilizadas não pode ser negativo'],
    validate: {
      validator: Number.isInteger,
      message: 'Sessões utilizadas deve ser um número inteiro'
    }
  },

  // ======================================================================
  // TEMPO E STATUS
  // ======================================================================

  expiresAt: {
    type: Date,
    required: [true, 'Data de validade é obrigatória'],
    index: true
  },

  status: {
    type: String,
    enum: {
      values: ['active', 'exhausted', 'expired', 'cancelled'],
      message: 'Status "{VALUE}" não é válido'
    },
    default: 'active',
    index: true
  },

  // ======================================================================
  // AUDITORIA
  // ======================================================================

  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },

  // ======================================================================
  // 📦 INTEGRAÇÃO COM PACOTES DE CONVÊNIO
  // (Opcional - default null = zero impacto no fluxo atual)
  // ======================================================================

  packageId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Package',
    default: null,
    description: 'ID do pacote de convênio (se guia foi convertida em pacote)'
  }

}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// ======================================================================
// VIRTUALS
// ======================================================================

/**
 * Virtual: remaining
 * Retorna o número de sessões restantes (sempre >= 0)
 */
insuranceGuideSchema.virtual('remaining').get(function () {
  const remaining = this.totalSessions - this.usedSessions;
  return Math.max(0, remaining);
});

// ======================================================================
// ÍNDICES COMPOSTOS
// ======================================================================

// Índice principal: busca de guia válida para agendamento
insuranceGuideSchema.index(
  { patientId: 1, specialty: 1, status: 1, expiresAt: 1 },
  { name: 'idx_valid_guide_lookup' }
);

// Índice para limpeza/relatórios de guias vencidas
insuranceGuideSchema.index(
  { expiresAt: 1, status: 1 },
  { name: 'idx_expiration_cleanup' }
);

// ======================================================================
// PRE-SAVE HOOKS (Regras de Negócio)
// ======================================================================

insuranceGuideSchema.pre('save', function (next) {
  // REGRA 1: usedSessions não pode exceder totalSessions
  if (this.usedSessions > this.totalSessions) {
    const err = new Error('Sessões utilizadas não podem exceder o total autorizado');
    err.code = 'GUIDE_OVERUSE';
    return next(err);
  }

  // REGRA 2: Auto-transição para 'exhausted' quando esgotada
  if (this.usedSessions >= this.totalSessions && this.status === 'active') {
    this.status = 'exhausted';
  }

  // REGRA 3: Bloquear reativação manual se esgotada
  if (this.status === 'active' && this.usedSessions >= this.totalSessions) {
    const err = new Error('Não é possível reativar guia esgotada');
    err.code = 'GUIDE_EXHAUSTED';
    return next(err);
  }

  // REGRA 4: Bloquear edição de campos críticos se já usada
  if (!this.isNew && this.usedSessions > 0) {
    if (this.isModified('number')) {
      return next(new Error('Não é possível alterar número de guia já utilizada'));
    }
    if (this.isModified('patientId')) {
      return next(new Error('Não é possível alterar paciente de guia já utilizada'));
    }
  }

  // REGRA 5: Bloquear redução de totalSessions para abaixo de usedSessions
  if (this.isModified('totalSessions') && this.totalSessions < this.usedSessions) {
    return next(new Error(
      `Total de sessões (${this.totalSessions}) não pode ser menor que sessões já utilizadas (${this.usedSessions})`
    ));
  }

  next();
});

// ======================================================================
// MÉTODOS ESTÁTICOS
// ======================================================================

/**
 * Busca uma guia válida para agendamento
 *
 * @param {ObjectId|string} patientId - ID do paciente
 * @param {string} specialty - Especialidade (ex: 'fonoaudiologia')
 * @param {Date} date - Data do agendamento (default: hoje)
 * @returns {Promise<InsuranceGuide|null>} Guia válida ou null
 *
 * @example
 * const guide = await InsuranceGuide.findValid(
 *   '507f1f77bcf86cd799439011',
 *   'fonoaudiologia',
 *   new Date('2025-02-15')
 * );
 */
insuranceGuideSchema.statics.findValid = async function (patientId, specialty, date = new Date()) {
  return await this.findOne({
    patientId: new mongoose.Types.ObjectId(patientId),
    specialty: specialty.toLowerCase().trim(),
    status: 'active',
    expiresAt: { $gte: date },
    $expr: { $lt: ['$usedSessions', '$totalSessions'] } // usedSessions < totalSessions
  })
    .sort({ expiresAt: 1 }) // FIFO: primeira a vencer
    .populate('patientId', 'fullName cpf')
    .lean(false); // Retorna documento Mongoose (não POJO)
};

/**
 * Retorna saldo agregado de guias ativas do paciente
 *
 * @param {ObjectId|string} patientId - ID do paciente
 * @param {string} [specialty] - Filtrar por especialidade (opcional)
 * @returns {Promise<Object>} Objeto com totalizadores
 *
 * @example
 * const balance = await InsuranceGuide.getBalance(
 *   '507f1f77bcf86cd799439011',
 *   'fonoaudiologia'
 * );
 * // Retorna:
 * // {
 * //   total: 20,        // soma de totalSessions
 * //   used: 8,          // soma de usedSessions
 * //   remaining: 12,    // soma de remaining
 * //   guides: [...]     // array de guias ativas
 * // }
 */
insuranceGuideSchema.statics.getBalance = async function (patientId, specialty = null) {
  const query = {
    patientId: new mongoose.Types.ObjectId(patientId),
    status: 'active',
    expiresAt: { $gte: new Date() } // Apenas não-vencidas
  };

  if (specialty) {
    query.specialty = specialty.toLowerCase().trim();
  }

  const guides = await this.find(query)
    .select('number specialty insurance totalSessions usedSessions expiresAt')
    .sort({ expiresAt: 1 })
    .lean();

  // Agregação manual (mais eficiente que $group para poucos docs)
  const totals = guides.reduce((acc, guide) => {
    acc.total += guide.totalSessions;
    acc.used += guide.usedSessions;
    return acc;
  }, { total: 0, used: 0 });

  return {
    total: totals.total,
    used: totals.used,
    remaining: Math.max(0, totals.total - totals.used),
    guides: guides.map(g => ({
      id: g._id,
      number: g.number,
      specialty: g.specialty,
      insurance: g.insurance,
      total: g.totalSessions,
      used: g.usedSessions,
      remaining: Math.max(0, g.totalSessions - g.usedSessions),
      expiresAt: g.expiresAt
    }))
  };
};

// ======================================================================
// MÉTODOS DE INSTÂNCIA
// ======================================================================

/**
 * Consome uma sessão da guia (incrementa usedSessions)
 * ⚠️ Deve ser chamado dentro de uma transação MongoDB
 *
 * @param {ClientSession} mongoSession - Sessão do MongoDB para transação
 * @returns {Promise<InsuranceGuide>} Guia atualizada (this)
 * @throws {Error} Se guia esgotada, vencida ou inativa
 *
 * @example
 * const session = await mongoose.startSession();
 * session.startTransaction();
 * try {
 *   await guide.consumeSession(session);
 *   // ... criar appointment, session, etc
 *   await session.commitTransaction();
 * } catch (err) {
 *   await session.abortTransaction();
 *   throw err;
 * } finally {
 *   session.endSession();
 * }
 */
insuranceGuideSchema.methods.consumeSession = async function (mongoSession) {
  // Validações críticas
  if (this.status !== 'active') {
    throw new Error(`Guia está ${this.status} e não pode ser utilizada`);
  }

  if (this.usedSessions >= this.totalSessions) {
    throw new Error('Guia não possui sessões disponíveis');
  }

  const now = new Date();
  if (this.expiresAt < now) {
    throw new Error('Guia expirada e não pode ser utilizada');
  }

  // Incrementa contador
  this.usedSessions += 1;

  // Auto-transição para 'exhausted' se necessário
  if (this.usedSessions >= this.totalSessions) {
    this.status = 'exhausted';
  }

  // Salva usando a transação passada
  await this.save({ session: mongoSession });

  return this;
};

/**
 * Verifica se a guia está válida para uso
 *
 * @returns {boolean} true se pode ser usada, false caso contrário
 *
 * @example
 * if (guide.isValid()) {
 *   await guide.consumeSession(session);
 * }
 */
insuranceGuideSchema.methods.isValid = function () {
  const now = new Date();
  return (
    this.status === 'active' &&
    this.usedSessions < this.totalSessions &&
    this.expiresAt >= now
  );
};

// ======================================================================
// EXPORT
// ======================================================================

const InsuranceGuide = mongoose.model('InsuranceGuide', insuranceGuideSchema);

export default InsuranceGuide;
