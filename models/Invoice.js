// models/Invoice.js
import mongoose from 'mongoose';

const invoiceItemSchema = new mongoose.Schema({
  description: { type: String, required: true },
  quantity: { type: Number, default: 1, min: 1 },
  unitValue: { type: Number, required: true, min: 0 },
  totalValue: { type: Number, required: true, min: 0 },
  
  // Vínculos
  appointment: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' },
  session: { type: mongoose.Schema.Types.ObjectId, ref: 'Session' },
  package: { type: mongoose.Schema.Types.ObjectId, ref: 'Package' },
  
  // Metadados
  serviceDate: Date,
  specialty: String,
  doctor: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor' }
}, { _id: true });

const invoiceSchema = new mongoose.Schema({
  // Identificação
  invoiceNumber: { 
    type: String, 
    required: true, 
    unique: true,
    index: true
  },
  
  // Quem paga (cobrança)
  type: { 
    type: String, 
    enum: ['patient', 'insurance'],
    required: true 
  },
  
  // Origem (de onde vem a cobrança)
  origin: {
    type: String,
    enum: ['session', 'package', 'batch'],
    required: true
  },
  
  // Vínculos
  patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
  doctor: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor' },
  appointment: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' }, // para invoices per-session
  package: { type: mongoose.Schema.Types.ObjectId, ref: 'Package' },
  insuranceProvider: { type: String },
  insuranceBatch: { type: mongoose.Schema.Types.ObjectId, ref: 'InsuranceBatch' },
  
  // Período
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  dueDate: { type: Date, required: true },
  
  // Itens
  items: [invoiceItemSchema],
  
  // Totais (snapshot, derivado dos pagamentos)
  subtotal: { type: Number, default: 0, min: 0 },
  discount: { type: Number, default: 0, min: 0 },
  total: { type: Number, default: 0, min: 0 },
  
  // Pagamentos (source of truth = Payment collection)
  payments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Payment' }],
  paidAmount: { type: Number, default: 0, min: 0 },
  balance: { type: Number, default: 0 },
  
  // Status
  status: {
    type: String,
    enum: ['draft', 'open', 'partial', 'paid', 'overdue', 'canceled'],
    default: 'draft'
  },
  
  // Datas importantes
  sentAt: Date,
  paidAt: Date,
  canceledAt: Date,
  
  // Lembretes
  remindersSent: { type: Number, default: 0 },
  lastReminderAt: Date,
  
  // Observações
  notes: String,
  cancelReason: String,
  
  // Event-Driven
  version: { type: Number, default: 2 },
  correlationId: String,
  
  // Controle
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, {
  timestamps: true
});

// Índices
invoiceSchema.index({ patient: 1, status: 1 });
invoiceSchema.index({ dueDate: 1, status: 1 });
invoiceSchema.index({ type: 1, status: 1 });
invoiceSchema.index({ origin: 1, status: 1 });
invoiceSchema.index({ insuranceProvider: 1, status: 1 });
invoiceSchema.index({ payments: 1 }); // 🔥 ESSENCIAL pra performance de addPayment

// 🛡️ UNIQUE INDEX: Previne duplicação de invoices per-session
// Apenas para invoices que têm um payment associado (type: 'per_session')
invoiceSchema.index(
  { payment: 1 },
  {
    unique: true,
    partialFilterExpression: {
      payment: { $exists: true },
      type: 'per_session'
    },
    name: 'idx_unique_per_session_payment'
  }
);

// Virtual: dias de atraso
invoiceSchema.virtual('daysOverdue').get(function() {
  if (this.status === 'paid' || this.status === 'canceled') return 0;
  
  const today = new Date();
  const due = new Date(this.dueDate);
  if (today <= due) return 0;
  
  const diffTime = today - due;
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
});

// Virtual: está vencida?
invoiceSchema.virtual('isOverdue').get(function() {
  if (this.status === 'paid' || this.status === 'canceled') return false;
  return new Date() > new Date(this.dueDate);
});

// 🚫 SEM MÉTODOS NO SCHEMA - tudo vai pro domínio:
// - generateInvoiceNumber → domain/invoice/generateInvoiceNumber.js
// - addPayment → domain/invoice/addPaymentToInvoice.js
// - cancel → domain/invoice/cancelInvoice.js
// - recalculate → domain/invoice/recalculateInvoice.js
// - findOverdue → query direta no controller/service

const Invoice = mongoose.model('Invoice', invoiceSchema);
export default Invoice;
