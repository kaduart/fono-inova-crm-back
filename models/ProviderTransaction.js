// models/ProviderTransaction.js
// Log técnico de baixo nível — vive na Provider Layer (Fase 2 v3, Seção 4.2), nunca no Fiscal
// Domain. Uma FiscalSubmission pode envolver 1+ ProviderTransaction (ex.: reautenticação antes de
// reenviar). Captura dados que "salvam dias de investigação quando o provedor municipal responde
// erro estranho de forma intermitente" — TLS e thumbprint específicos da chamada, não do momento
// atual do Certificate (que pode ter girado desde então).
import mongoose from 'mongoose';

const providerTransactionSchema = new mongoose.Schema({
  fiscalSubmission: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'FiscalSubmission',
    required: true,
    index: true
  },
  attemptId: { type: String, required: true, index: true },
  traceId: { type: String },
  endpoint: { type: String },
  httpStatus: { type: Number },
  request: { type: mongoose.Schema.Types.Mixed },
  response: { type: mongoose.Schema.Types.Mixed },
  headers: { type: mongoose.Schema.Types.Mixed },
  duration: { type: Number }, // ms
  tlsVersion: { type: String },
  // Capturado no momento da chamada, nunca recalculado depois (invariante #17)
  certificateThumbprint: { type: String },
  providerVersion: { type: String },
  retryOf: { type: mongoose.Schema.Types.ObjectId, ref: 'ProviderTransaction' }
}, { timestamps: true });

providerTransactionSchema.index({ traceId: 1 });
providerTransactionSchema.index({ providerVersion: 1 });

const ProviderTransaction = mongoose.models.ProviderTransaction || mongoose.model('ProviderTransaction', providerTransactionSchema);
export default ProviderTransaction;
