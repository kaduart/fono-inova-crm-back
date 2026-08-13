// models/InsuranceBatch.js
// Migration 2: Lotes de Faturamento Convênio

import mongoose from 'mongoose';

const insuranceBatchSessionSchema = new mongoose.Schema({
  session: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', required: true },
  appointment: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', required: true },
  guide: { type: mongoose.Schema.Types.ObjectId, ref: 'InsuranceGuide' },
  payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },
  protocolItemId: { type: String },
  
  // Valores
  grossAmount: { type: Number, required: true },
  netAmount: { type: Number },
  
  // Status no lote
  status: {
    type: String,
    enum: ['pending', 'sent', 'processing', 'paid', 'rejected', 'partial'],
    default: 'pending'
  },
  
  // Retorno do convênio
  returnAmount: Number,
  glosaAmount: Number,
  glosaReason: String,
  protocolNumber: String,
  
  // Data da sessão original — usada para atribuir o recebimento ao mês de competência
  sessionDate: Date,

  // ── Reconciliação legada ────────────────────────────────────────────────
  // De onde saiu o `grossAmount` deste item. O valor histórico pode divergir do
  // Payment vigente (reajuste de tabela, nota emitida com outro valor), e nesse
  // caso o documento manda — mas a divergência fica registrada, nunca silenciosa.
  valueSource: {
    type: String,
    enum: ['legacy_document', 'canonical_payment', 'payment_amount', null],
    default: null
  },
  originalPaymentAmount: { type: Number, default: null },
  reconciliationDifference: { type: Number, default: null },

  // Controle
  sentAt: Date,
  processedAt: Date,
  updatedAt: { type: Date, default: Date.now }
}, { _id: true });

const insuranceBatchSchema = new mongoose.Schema({
  // Novo fluxo: vínculo estrutural com a intenção operacional que originou o lote.
  // Ausente em registros legados; obrigatório no command BillingSubmission.
  billingSubmissionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BillingSubmission',
    index: true,
    default: null
  },
  billingAllocationId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null
  },
  // Identificação
  batchNumber: { 
    type: String, 
    required: true, 
    unique: true,
    index: true 
  },
  
  // Convênio
  insuranceProvider: { type: String, required: true },

  // Paciente. A NF histórica é emitida por paciente: uma nota agrupava várias
  // guias do MESMO paciente numa competência. Derivável das sessões, mas sem o
  // campo não há como consultar nem indexar por paciente.
  patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', default: null, index: true },
  
  // Período
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  sentDate: Date,
  
  // Sessões incluídas
  sessions: [insuranceBatchSessionSchema],
  
  // Totais
  totalGross: { type: Number, default: 0 },
  totalNet: { type: Number, default: 0 },
  totalSessions: { type: Number, default: 0 },
  
  // Retorno do convênio
  receivedAmount: { type: Number, default: 0 },
  // Liquidação integral da NF/lote. Durante baixa por guia o agregado fica
  // `partial`; estes campos só são preenchidos quando todas as sessões recebem.
  receivedAt: { type: Date, default: null, index: true },
  receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // Glosa = recusa do convênio. NÃO usar para imposto retido: são coisas
  // diferentes e `expectedAmount` abaixo depende dessa distinção.
  totalGlosa: { type: Number, default: 0 },

  // Retenção fiscal na fonte (ex: ISS Unimed 2,01%). Separado da glosa.
  // null = não documentado — a nota não discriminou, e nada deve ser deduzido
  // automaticamente a partir do rótulo "total da nota".
  issRate: { type: Number, default: null },
  issAmount: { type: Number, default: null },
  
  // Documentos fiscais (copiados da InsuranceCommunication que originou o lote)
  invoiceNumber: { type: String, index: true },
  invoiceDate: Date,
  invoiceDocumentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PatientDocument',
    default: null
  },
  
  // Status
  //
  // `superseded` e `voided` são estados TERMINAIS de invalidação e nunca devem
  // aparecer em lista ativa, total, NF, recebimento ou edição. São distintos de
  // propósito:
  //   superseded — o lote tinha faturamento válido, mas foi substituído por lotes
  //                normalizados (ex.: um lote legado que misturava 4 pacientes e
  //                2 competências, desmembrado em NFs por paciente+competência).
  //   voided     — o lote não tem sessão nem débito válido; foi invalidado.
  // Confundir os dois apaga a diferença entre "migrado" e "lixo".
  status: {
    type: String,
    enum: ['building', 'ready', 'sent', 'processing', 'partial', 'received', 'rejected', 'closed', 'superseded', 'voided'],
    default: 'building'
  },
  
  // Documentos
  xmlFile: String,
  returnFile: String,
  
  // Origem do lote. `legacy_reconciliation` = NF antiga registrada a posteriori,
  // com datas históricas. Nunca deve ser confundido com faturamento executado
  // pelo sistema em nenhum relatório.
  origin: {
    type: String,
    enum: ['current_billing', 'legacy_reconciliation'],
    default: 'current_billing',
    index: true
  },

  // Fotografia da conferência contra o documento físico.
  // `expectedGross` = soma dos itens; `documentedGross/Net` = o que a NF mostra.
  // Divergência não bloqueia: o documento prevalece e a diferença fica registrada.
  reconciliation: {
    status: {
      type: String,
      enum: ['matched', 'divergent', 'manual_override', null],
      default: null
    },
    reason: { type: String, default: null },
    expectedGross: { type: Number, default: null },
    documentedGross: { type: Number, default: null },
    documentedNet: { type: Number, default: null },
    difference: { type: Number, default: null },
    documentReference: { type: String, default: null }
  },
  reconciledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reconciledAt: { type: Date, default: null },

  // ─── Rastreabilidade de substituição/invalidação ────────────────────────────
  // Lotes legados de origem que este lote normalizado substitui. Preenchido nos
  // lotes NOVOS criados pelo desmembramento por paciente+competência.
  sourceLegacyBatchIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'InsuranceBatch' }],

  // Caminho inverso: preenchido nos lotes ANTIGOS, apontando para os que os
  // sucederam. Sem os dois lados, uma auditoria futura que caia num lote
  // superseded não tem como chegar ao faturamento que passou a valer.
  supersededByBatchIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'InsuranceBatch' }],
  supersededAt: { type: Date, default: null },
  supersededBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  supersededReason: { type: String, default: null },

  voidedAt: { type: Date, default: null },
  voidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  voidReason: { type: String, default: null },

  // Status que o lote tinha antes de ser invalidado. É o que torna a reversão
  // possível — sem ele não se sabe para onde voltar.
  statusBeforeInvalidation: { type: String, default: null },

  // Trilha de troca do número da NF. O número provisório
  // (PACIENTE-MES_COMPETENCIA) é substituído pelo real depois, e a troca precisa
  // ficar registrada: antes só existia `previousInvoiceNumber` no retorno da
  // função, sem nada persistido.
  invoiceNumberHistory: [{
    previousInvoiceNumber: { type: String, default: null },
    newInvoiceNumber: { type: String, required: true },
    changedAt: { type: Date, required: true },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reason: { type: String, default: null }
  }],

  // Controle
  processedAt: Date,
  processedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // ⚠️ `sentBy` era atribuído por insuranceBatchService.sendBatch() sem existir
  // no schema — o mongoose descartava em silêncio e ninguém nunca soube quem
  // enviou um lote. Declarado aqui para o valor passar a ser gravado.
  sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  notes: String,
  
  // Event-Driven
  correlationId: String
}, {
  timestamps: true
});

// Índices
insuranceBatchSchema.index({ insuranceProvider: 1, status: 1 });
insuranceBatchSchema.index({ startDate: 1, endDate: 1 });
insuranceBatchSchema.index({ status: 1, createdAt: 1 });
insuranceBatchSchema.index({ invoiceNumber: 1, status: 1 });
insuranceBatchSchema.index({ 'sessions.session': 1 });
insuranceBatchSchema.index({ 'sessions.appointment': 1 });
insuranceBatchSchema.index(
  { billingSubmissionId: 1, billingAllocationId: 1 },
  {
    unique: true,
    partialFilterExpression: { billingSubmissionId: { $type: 'objectId' } },
    name: 'unique_batch_per_submission_allocation'
  }
);

// Virtual: sessões pendentes
insuranceBatchSchema.virtual('pendingSessions').get(function() {
  return this.sessions.filter(s => s.status === 'pending').length;
});

// Virtual: valor a receber
insuranceBatchSchema.virtual('expectedAmount').get(function() {
  return this.totalGross - this.totalGlosa;
});

const InsuranceBatch = mongoose.model('InsuranceBatch', insuranceBatchSchema);
export default InsuranceBatch;
