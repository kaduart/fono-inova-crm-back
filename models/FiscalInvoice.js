// models/FiscalInvoice.js
// Agregado raiz do Fiscal Domain (Fase 2 v3, Seção 2.1). Documento fiscal do ponto de vista do
// CRM — não é o XML em si (isso é FiscalAttachment/FiscalSnapshot), é o registro que rastreia o
// ciclo de vida da NFS-e.
//
// Invariantes que este schema por si só NÃO garante (ficam para o FiscalStateMachineService / PR2):
//  - status nunca deve ser setado diretamente fora do FiscalStateMachineService
//  - liminarFlow nunca deve ser inferido automaticamente de Package.type === 'liminar'
//  - origin nunca deve ser um array de Payment — payments participantes são resolvidos por
//    projeção de leitura (FiscalInvoicePaymentProjection), não persistidos aqui
import mongoose from 'mongoose';
import {
  FiscalInvoiceStatus,
  CStat,
  AmbGer,
  TpEmis,
  FiscalOriginType,
  LiminarFlow
} from '../constants/fiscalEnums.js';

const fiscalInvoiceItemSchema = new mongoose.Schema({
  description: { type: String, required: true },
  quantity: { type: Number, default: 1, min: 1 },
  unitValue: { type: Number, required: true, min: 0 },
  totalValue: { type: Number, required: true, min: 0 },
  session: { type: mongoose.Schema.Types.ObjectId, ref: 'Session' },
  appointment: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' },
  specialty: { type: String },
  doctor: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor' },
  serviceDate: { type: Date }
}, { _id: true });

const fiscalInvoiceSchema = new mongoose.Schema({
  status: {
    type: String,
    enum: Object.values(FiscalInvoiceStatus),
    default: FiscalInvoiceStatus.DRAFT,
    index: true
  },

  // Campos oficiais do documento (não são infra) — preenchidos a partir da resposta do provider
  cStat: { type: Number, enum: Object.values(CStat) },
  ambGer: { type: Number, enum: Object.values(AmbGer) },
  tpEmis: { type: Number, enum: Object.values(TpEmis) },

  // Substitui referência direta a Payment (Fase 2 v3, invariante #14)
  origin: {
    type: {
      type: String,
      enum: Object.values(FiscalOriginType),
      required: true
    },
    id: { type: mongoose.Schema.Types.ObjectId, required: true }
  },

  fiscalProfileId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'FiscalProfile',
    required: true,
    index: true
  },

  dpsId: { type: String, maxlength: 45 },
  chaveAcesso: { type: String, maxlength: 53, unique: true, sparse: true },
  nNFSe: { type: Number },
  serie: { type: Number },

  dhEmi: { type: Date },
  dhProc: { type: Date },
  dCompet: { type: Date },

  // Referência informativa — nunca fusão de estado com Invoice.status (invariante #1)
  invoiceRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },

  patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
  responsibleParty: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient' },
  professional: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor' },
  packageRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Package' },

  items: [fiscalInvoiceItemSchema],

  serviceDescription: { type: String },
  serviceCode: { type: String }, // cTribNac, snapshot no momento da emissão

  valorServico: { type: Number, min: 0 },
  valorLiquido: { type: Number, min: 0 },
  vISSQN: { type: Number, min: 0 },

  // Campo explícito — nunca inferido automaticamente (Fase 2 v3, Seção 6)
  liminarFlow: {
    type: String,
    enum: Object.values(LiminarFlow),
    default: LiminarFlow.NONE
  },

  substitutes: { type: mongoose.Schema.Types.ObjectId, ref: 'FiscalInvoice' },
  substitutedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'FiscalInvoice' },

  rejectionReason: { type: String },

  // Sub-histórico paralelo de manifestações (não muda status) e flags de bloqueio por ofício
  manifestations: [{ type: mongoose.Schema.Types.ObjectId, ref: 'OfficialFiscalEvent' }],
  blockedEventTypes: [{ type: Number }],

  correlationId: { type: String, index: true },
  version: { type: Number, default: 1 },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

fiscalInvoiceSchema.index({ status: 1, createdAt: -1 });
fiscalInvoiceSchema.index({ 'origin.type': 1, 'origin.id': 1 });
fiscalInvoiceSchema.index({ nNFSe: 1, serie: 1 });
fiscalInvoiceSchema.index({ patient: 1, createdAt: -1 });
fiscalInvoiceSchema.index({ professional: 1, createdAt: -1 });

const FiscalInvoice = mongoose.models.FiscalInvoice || mongoose.model('FiscalInvoice', fiscalInvoiceSchema);
export default FiscalInvoice;
