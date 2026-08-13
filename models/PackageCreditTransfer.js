import mongoose from 'mongoose';

/**
 * PackageCreditTransfer
 *
 * Registra a transferência de COBERTURA JÁ PAGA entre dois pacotes, quando
 * sessões contratadas e não realizadas mudam de destino (ex.: 4 de fono viram
 * 4 de psicologia).
 *
 * ⚠️ NÃO é movimento financeiro. Regras invioláveis:
 * - O pacote de origem preserva totalSessions e totalValue originais — a venda
 *   e o recebimento são fatos históricos e não podem ser reescritos.
 * - O pacote de destino nasce financiado por esta transferência, com
 *   ENTRADA NOVA EM CAIXA IGUAL A ZERO. Nenhum Payment de recebimento é criado.
 * - Não usa PatientBalance: crédito solto no saldo do paciente pode ser gasto
 *   em qualquer coisa e perde a rastreabilidade origem→destino.
 * - Sessões já realizadas nunca são tocadas.
 *
 * Ver ADR em docs/DOMAIN_INVARIANTS.md e o command
 * services/billing/commands/transferPackageCreditCommand.js.
 */
const packageCreditTransferSchema = new mongoose.Schema({
  sourcePackageId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Package',
    required: true,
    index: true,
    description: 'Pacote que cede as sessões não realizadas'
  },
  targetPackageId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Package',
    required: true,
    index: true,
    description: 'Pacote criado/financiado pela transferência'
  },
  patientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Patient',
    required: true,
    index: true
  },

  sessionCount: {
    type: Number,
    required: true,
    min: 1,
    description: 'Quantidade de sessões transferidas'
  },
  unitValue: {
    type: Number,
    required: true,
    min: 0,
    description: 'Valor por sessão no pacote de ORIGEM (base do cálculo)'
  },
  amount: {
    type: Number,
    required: true,
    min: 0,
    description: 'Cobertura transferida = sessionCount × unitValue. Nunca entra no caixa.'
  },

  /**
   * Appointments/Sessions reaproveitados. Guardar aqui é o que impede
   * transferir a mesma sessão duas vezes (ver guard no command).
   */
  transferredAppointmentIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Appointment'
  }],
  transferredSessionIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Session'
  }],

  reason: {
    type: String,
    required: true,
    trim: true,
    maxlength: 500,
    description: 'Justificativa clínica/administrativa da conversão'
  },

  status: {
    type: String,
    enum: ['completed', 'reversed'],
    default: 'completed',
    index: true
  },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reversedAt: { type: Date, default: null },
  reversedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reversalReason: { type: String, default: null },

  /**
   * Idempotência: duas requisições com a mesma chave produzem UMA transferência.
   * Protege contra duplo clique e retry de rede — que aqui significariam
   * cobertura duplicada, ou seja, sessão de graça.
   */
  idempotencyKey: {
    type: String,
    required: true,
    unique: true,
    index: true
  },

  correlationId: { type: String, default: null }
}, {
  timestamps: true,
  collection: 'package_credit_transfers'
});

// Uma sessão só pode ser transferida uma vez (consulta do guard de duplo consumo)
packageCreditTransferSchema.index({ transferredAppointmentIds: 1, status: 1 });
packageCreditTransferSchema.index({ sourcePackageId: 1, status: 1 });

const PackageCreditTransfer = mongoose.model('PackageCreditTransfer', packageCreditTransferSchema);
export default PackageCreditTransfer;
