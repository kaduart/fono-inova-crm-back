import mongoose from 'mongoose';

const packageSchema = new mongoose.Schema({
  version: { type: Number, default: 0 },
  durationMonths: { type: Number, required: true, min: 1, max: 12 },
  sessionsPerWeek: { type: Number, required: true, min: 1, max: 5 },
  patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
  doctor: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
  paymentMethod: { type: String },
  paymentType: { type: String },
  sessionType: {
    type: String,
    enum: ['fonoaudiologia', 'terapia_ocupacional', 'psicologia', 'fisioterapia', 'psicomotricidade', 'musicoterapia', 'psicopedagogia', 'neuropediatria', 'neuroped'],
    required: true
  },
  sessionValue: {
    type: Number,
    default: 200,
    validate: {
      validator: function(value) {
        // Para pacotes de convênio, aceita 0
        if (this.type === 'convenio') {
          return value >= 0;
        }
        // Para pacotes therapy e liminar, exige >= 0.01 (liminar precisa do valor para calcular crédito!)
        return value >= 0.01;
      },
      message: 'Valor da sessão deve ser maior que zero para pacotes particulares'
    }
  },
  totalSessions: { type: Number, default: 1, min: 1 },
  sessions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Session' }],
  appointments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' }],
  date: { type: Date, required: true },
  time: { type: String },
  sessionsDone: { type: Number, default: 0 },
  payments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Payment' }],
  status: { type: String, enum: ['active', 'in-progress', 'completed'], default: 'active' },
  balance: { type: Number, default: 0 },
  credit: { type: Number, default: 0 },
  specialty: {
    type: String,
    required: true,
    enum: ['fonoaudiologia', 'terapia_ocupacional', 'psicologia', 'fisioterapia', 'pediatria', 'neuroped', 'neuropediatria', 'psicomotricidade', 'musicoterapia', 'psicopedagogia']
  },
  firstAppointment: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' },
  financialStatus: {
    type: String,
    enum: ['unpaid', 'partially_paid', 'paid'],
    default: 'unpaid',
    description: 'Controle do status financeiro do pacote'
  },

  paidSessions: {
    type: Number,
    default: 0,
    description: 'Número total (possivelmente fracionado) de sessões quitadas'
  },

  totalPaid: {
    type: Number,
    default: 0,
    description: 'Valor total já pago pelo paciente neste pacote'
  },
  totalValue: {
    type: Number,
    required: true,
    min: 0,
    description: 'Valor total fixo do pacote (do payment inicial)'
  },
  lastPaymentAt: {
    type: Date,
    description: 'Data do último pagamento recebido'
  },
  txid: { type: String, unique: true, sparse: true },
  metadata: {
    requestId: { type: String, index: true },
    correlationId: { type: String },
    createdAt: { type: Date }
  },

  // ========================================
  // 🏥 CAMPOS PARA PACOTES DE CONVÊNIO E LIMINAR
  // (Opcionais - default null = zero impacto em pacotes therapy)
  // ========================================
  type: {
    type: String,
    enum: ['therapy', 'convenio', 'liminar'],
    default: 'therapy',
    description: 'Tipo de pacote: therapy (particular), convenio (plano de saúde) ou liminar (judicial)'
  },
  
  // ========================================
  // ⚖️ CAMPOS ESPECÍFICOS PARA PACOTES LIMINAR
  // ========================================
  // NOTA: Todos os campos são OPCIONAIS. O sistema não exige processo ou vara.
  // O crédito é consumido quando a sessão é marcada como 'completed'.
  // Se alterar o status de 'completed' para outro, o crédito VOLTA automaticamente.
  // Não é necessário cancelar a sessão para restaurar o crédito!
  liminarProcessNumber: {
    type: String,
    default: null,
    description: 'Número do processo judicial (opcional)'
  },
  liminarCourt: {
    type: String,
    default: null,
    description: 'Vara ou cartório responsável (opcional)'
  },
  liminarExpirationDate: {
    type: Date,
    default: null,
    description: 'Data de validade da liminar (se houver)'
  },
  liminarMode: {
    type: String,
    enum: ['deferred', 'immediate', 'hybrid'],
    default: 'hybrid',
    description: 'Modo de reconhecimento de receita: deferred (diferida), immediate (imediata) ou hybrid (híbrida)'
  },
  liminarAuthorized: {
    type: Boolean,
    default: true,
    description: 'Se a liminar está autorizada para uso'
  },
  liminarCreditBalance: {
    type: Number,
    default: 0,
    description: 'Saldo de crédito da liminar para consumo por sessão'
  },
  liminarTotalCredit: {
    type: Number,
    default: 0,
    description: 'Valor total do crédito liberado pela liminar'
  },
  // Campo para rastrear receita já reconhecida (quando usar deferred/hybrid)
  recognizedRevenue: {
    type: Number,
    default: 0,
    description: 'Valor da receita já reconhecida (para liminar deferred/hybrid)'
  },
  insuranceGuide: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'InsuranceGuide',
    default: null,
    description: 'Guia de convênio vinculada (apenas para type=convenio)'
  },
  insuranceProvider: {
    type: String,
    default: null,
    description: 'Nome do convênio (ex: unimed-anapolis)'
  },
  insuranceGrossAmount: {
    type: Number,
    default: 0,
    description: 'Valor que o convênio paga por sessão'
  },
  insuranceBillingStatus: {
    type: String,
    enum: ['pending_batch', 'in_batch', 'billed', 'received', null],
    default: null,
    description: 'Status do faturamento junto ao convênio'
  },
  calculationMode: {
    type: String,
    enum: ['sessions', 'duration', null],
    default: null,
    description: 'Modo de cálculo: por número de sessões ou duração em meses'
  },
  
  // 🎯 MODELO DO PACOTE (V2) - determina comportamento financeiro
  model: {
    type: String,
    enum: ['prepaid', 'per_session', 'convenio', 'liminar', null],
    default: null,
    description: 'Modelo do pacote: prepaid (pago antecipado), per_session (pagar por sessão), convenio (plano de saúde), liminar (judicial)'
  },
  
  // 🔑 IDEMPOTÊNCIA - proteção contra duplicação (V2)
  idempotencyKey: {
    type: String,
    index: true,
    unique: true,
    sparse: true, // só único quando preenchido
    description: 'Chave única para evitar criação duplicada (ex: whatsapp_12345)'
  }

});

packageSchema.virtual('remainingSessions').get(function () {
  return this.totalSessions - this.sessionsDone;
});

packageSchema.set('toJSON', { virtuals: true });
packageSchema.set('toObject', { virtuals: true })

packageSchema.pre('save', function (next) {
  // ✅ USAR totalValue FIXO:
  if (this.totalValue !== undefined && !isNaN(this.totalValue)) {
    this.balance = this.totalValue - (this.totalPaid || 0);
  }

  // Status financeiro
  if (this.totalPaid === 0) {
    this.financialStatus = 'unpaid';
  } else if (this.totalPaid < this.totalValue) {
    this.financialStatus = 'partially_paid';
  } else {
    this.financialStatus = 'paid';
  }

  next();
});


const Package = mongoose.model('Package', packageSchema);
export default Package;
