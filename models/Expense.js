import mongoose from 'mongoose';

const expenseSchema = new mongoose.Schema({
  description: {
    type: String,
    required: true,
    trim: true,
    maxlength: 200
  },
  
  category: {
    type: String,
    required: true,
    enum: [
      'payroll',           // Folha de pagamento (salários fixos)
      'commission',        // Comissões variáveis
      'benefit',           // Benefícios (vale-transporte, alimentação)
      'operational',       // Despesas operacionais (aluguel, luz, internet)
      'equipment',         // Equipamentos e materiais
      'marketing',         // Marketing e publicidade
      'other'              // Outros
    ]
  },
  
  subcategory: {
    type: String,
    enum: [
      'salary',            // Salário base
      'bonus',             // Bônus/gratificação
      'transport',         // Vale-transporte
      'meal_voucher',      // Vale-refeição
      'health_insurance',  // Plano de saúde
      'rent',              // Aluguel
      'utilities',         // Água, luz, internet
      'supplies',          // Material de escritório/clínico
      'maintenance',       // Manutenção
      'advertising',       // Publicidade
      'other'
    ],
    default: null
  },
  
  amount: {
    type: Number,
    required: true,
    min: [0.01, 'Valor deve ser maior que zero']
  },
  
  date: {
    type: String, // formato 'YYYY-MM-DD' igual ao Payment
    required: true,
    index: true
  },
  
  // 🔹 VÍNCULO OPCIONAL COM PROFISSIONAL
  relatedDoctor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Doctor',
    default: null,
    index: true
  },
  
  // 🔹 PERÍODO DE REFERÊNCIA (para honorários mensais)
  workPeriod: {
    start: { type: String }, // 'YYYY-MM-DD'
    end: { type: String },   // 'YYYY-MM-DD'
    sessionsCount: { type: Number, default: 0 },
    revenueGenerated: { type: Number, default: 0 }
  },
  
  paymentMethod: {
    type: String,
    enum: ['dinheiro', 'pix', 'transferencia_bancaria', 'cartao_credito', 'cartao_debito', 'boleto', 'outro'],
    required: true
  },
  
  status: {
    type: String,
    enum: ['paid', 'pending', 'scheduled', 'canceled'],
    default: 'pending',
    index: true
  },
  
  // 🔹 RECORRÊNCIA (para despesas fixas mensais)
  isRecurring: {
    type: Boolean,
    default: false
  },
  
  recurrence: {
    frequency: {
      type: String,
      enum: ['monthly', 'weekly', 'biweekly', 'quarterly', 'yearly'],
      default: null
    },
    nextOccurrence: { type: String }, // 'YYYY-MM-DD'
    endDate: { type: String },        // 'YYYY-MM-DD' (quando parar de gerar)
    parentExpense: {                  // ID da despesa "mãe" que gerou esta
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Expense',
      default: null
    }
  },
  
  // 🔹 COMPROVANTE (URL S3/Cloudinary - futuro)
  attachment: {
    type: String,
    default: null
  },
  
  notes: {
    type: String,
    maxlength: 500,
    default: ''
  },
  
  // 🔹 AUDITORIA
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// 🔹 ÍNDICES COMPOSTOS (performance)
expenseSchema.index({ date: 1, status: 1 });
expenseSchema.index({ relatedDoctor: 1, date: 1 });
expenseSchema.index({ category: 1, date: 1 });
expenseSchema.index({ createdAt: 1, status: 1 });

// 🔹 PRE-SAVE: atualizar updatedAt
expenseSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// 🔹 VIRTUAL: nome do profissional
expenseSchema.virtual('doctorName', {
  ref: 'Doctor',
  localField: 'relatedDoctor',
  foreignField: '_id',
  justOne: true
});

const Expense = mongoose.model('Expense', expenseSchema);
export default Expense;