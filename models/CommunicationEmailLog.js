// models/CommunicationEmailLog.js
// Registro imutável de cada envio/tentativa de comunicação com convênio por e-mail.
import mongoose from 'mongoose';

export const EmailLogStatus = {
  // Gravado ANTES de chamar o provedor de e-mail — marca que este jobId já tentou
  // contatar o Resend, mesmo que o processo trave/reinicie logo depois (ver
  // sendCommunicationEmail: sem isso, um reprocessamento do mesmo job não tinha como
  // saber que um envio real já tinha sido tentado).
  PENDING: 'pending',
  SUCCESS: 'success',
  ERROR: 'error'
};

export const EmailLogType = {
  FIRST_SEND: 'first_send',
  RESEND: 'resend',
  COMPLEMENT: 'complement',
  // Sem nenhum fluxo que grave este valor ainda — reservado pro caso de alguém
  // reenviar alterando destinatário/anexos/assunto por completo (não é reenvio
  // nem complemento no sentido estrito). Adicionado a pedido, ver conversa 2026-08-04.
  MANUAL: 'manual'
};

const communicationEmailLogSchema = new mongoose.Schema({
  communicationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'InsuranceCommunication',
    required: true,
    index: true
  },
  communicationPackageId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CommunicationPackage',
    required: true,
    index: true
  },
  to: {
    type: String,
    required: true
  },
  subject: {
    type: String,
    required: true
  },
  template: {
    type: String
  },
  message: {
    type: String
  },
  attachments: [{
    documentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PatientDocument'
    },
    publicId: String,
    url: String,
    name: String,
    hash: String,
    mimeType: String,
    size: Number
  }],
  attempt: {
    type: Number,
    default: 1
  },
  type: {
    type: String,
    enum: Object.values(EmailLogType),
    default: EmailLogType.FIRST_SEND
  },
  ip: {
    type: String
  },
  reason: {
    type: String,
    trim: true
  },
  // Id do job do BullMQ que gerou este envio. Estável entre retries do MESMO job
  // (mesmo jobId reaproveitado pelo BullMQ em "attempts"/stalled-job) — usado como
  // chave de idempotência: se já existe um log de sucesso com este jobId, uma nova
  // tentativa do mesmo job não deve reenviar de verdade (achado 2026-08-04: fila sem
  // idempotência causou 5 e-mails reais duplicados quando algo travava depois do envio).
  jobId: {
    type: String,
    index: true
  },
  lastAttemptAt: {
    type: Date
  },
  durationMs: {
    type: Number
  },
  protocol: {
    type: String,
    trim: true
  },
  // Message-ID real retornado pelo provedor (Resend: campo message_id obtido via
  // webhook email.sent; SMTP: messageId do nodemailer). Usado para manter thread
  // de conversa quando o usuário reenvia/complementa a comunicação.
  messageId: {
    type: String,
    trim: true,
    index: true
  },
  // Qual provider (resend/smtp) processou este envio — sem isso, se o provider
  // configurado mudar no futuro, não dá pra saber depois qual serviço enviou
  // um e-mail específico só olhando o protocolo (que é só o id retornado por ele).
  provider: {
    type: String,
    trim: true
  },
  status: {
    type: String,
    enum: Object.values(EmailLogStatus),
    required: true
  },
  errorMessage: {
    type: String
  },
  sentBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  sentAt: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

communicationEmailLogSchema.index({ communicationId: 1, sentAt: -1 });
// A aba "Envios" consulta por um conjunto de communicationIds ($in) ordenando por
// sentAt globalmente — um índice próprio em sentAt garante isso mesmo quando o Mongo
// não conseguir aproveitar o índice composto acima pro merge-sort entre várias guias.
communicationEmailLogSchema.index({ sentAt: -1 });
communicationEmailLogSchema.index({ type: 1 });
communicationEmailLogSchema.index({ status: 1 });

const CommunicationEmailLog = mongoose.models.CommunicationEmailLog || mongoose.model('CommunicationEmailLog', communicationEmailLogSchema);
export default CommunicationEmailLog;
