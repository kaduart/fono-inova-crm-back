// models/FiscalSubmission.js
// Aggregate Root próprio (Fase 2 v3, Seção 2.6) — não é só um log dentro de FiscalInvoice.
// Funciona como o "Outbox" do módulo fiscal: a API oficial não oferece idempotency-key, então
// toda tentativa de emissão passa por um registro aqui ANTES do POST (invariante #7). Relação 1:N
// com FiscalInvoice (várias tentativas até autorizar ou desistir). Filhos: 1 FiscalSnapshot
// (o que foi enviado) e N ProviderTransaction (execução HTTP).
import mongoose from 'mongoose';
import { FiscalSubmissionOutcome } from '../constants/fiscalEnums.js';
import { FiscalProviderName } from '../constants/fiscalProviders.js';

const fiscalSubmissionSchema = new mongoose.Schema({
  // Nullable: pode não existir ainda uma FiscalInvoice se a tentativa falhou antes de criar o registro
  fiscalInvoice: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'FiscalInvoice',
    index: true
  },
  // Único lugar onde o nome do provedor/vendor aparece — nunca em FiscalInvoice (invariante #8)
  providerSnapshot: {
    type: String,
    enum: Object.values(FiscalProviderName)
  },
  attemptNumber: { type: Number, required: true, default: 1 },
  outcome: {
    type: String,
    enum: Object.values(FiscalSubmissionOutcome),
    default: FiscalSubmissionOutcome.PENDING,
    required: true
  },
  errorCode: { type: String },
  attemptedAt: { type: Date, default: Date.now }
}, { timestamps: true });

fiscalSubmissionSchema.index({ fiscalInvoice: 1, attemptNumber: 1 });
fiscalSubmissionSchema.index({ outcome: 1 });
fiscalSubmissionSchema.index({ createdAt: -1 });

const FiscalSubmission = mongoose.models.FiscalSubmission || mongoose.model('FiscalSubmission', fiscalSubmissionSchema);
export default FiscalSubmission;
