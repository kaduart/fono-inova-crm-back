// models/AdConversion.js
// 1 documento por agendamento enviado às plataformas de anúncio.
// unique(appointment) = idempotência: nunca envia a mesma conversão 2x.
import mongoose from 'mongoose';

const platformSchema = new mongoose.Schema({
  status: { type: String, enum: ['pending', 'sent', 'skipped', 'failed'], default: 'pending' },
  sentAt: { type: Date, default: null },
  reason: { type: String, default: null },   // motivo do skip/falha (sem dados clínicos)
  // #4 Resposta efetiva da plataforma (aditivo). Nunca grava dado clínico/PII.
  eventsReceived: { type: Number, default: null }, // Meta: events_received da resposta
  trace: { type: String, default: null },          // Meta fbtrace_id / TikTok request_id
  pixel: { type: String, default: null },          // dataset/pixel de destino efetivo
  event: { type: String, default: null },          // nome do evento enviado (ex.: Purchase)
  actionSource: { type: String, default: null },   // action_source usado (ex.: physical_store)
}, { _id: false });

const adConversionSchema = new mongoose.Schema({
  appointment: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', required: true, unique: true },
  // #3 Dedupe por PACIENTE (além de por agendamento): o índice parcial único abaixo
  // garante no nível do banco uma única linha de AQUISIÇÃO por paciente, mesmo sob
  // execução concorrente ou remarcação (novo agendamento do mesmo paciente).
  patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', default: null },
  isAcquisition: { type: Boolean, default: false }, // true = linha que representa a 1ª vez do paciente
  phone: { type: String, default: null },
  source: { type: String, default: 'unknown' },
  attributionMethod: { type: String, default: null },
  adId: { type: String, default: null },       // anúncio de WhatsApp (ctwa) que originou a conversa
  campaign: { type: String, default: null },   // campanha/ID vindo do link do site (---ref)
  gclid: { type: String, default: null },
  fbc: { type: String, default: null },        // fb.1.<ms>.<fbclid> — identificador de clique da Meta
  ttclid: { type: String, default: null },     // TikTok Click ID (anúncio → site → WhatsApp)
  ctwaClid: { type: String, default: null },   // Click-to-WhatsApp (CTWA) click ID da Meta
  value: { type: Number, default: 0 },
  eventTime: { type: Date, required: true },
  meta: { type: platformSchema, default: () => ({}) },
  google: { type: platformSchema, default: () => ({}) },
  tiktok: { type: platformSchema, default: () => ({}) },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now, index: true },
  done: { type: Boolean, default: false, index: true },
}, { timestamps: true });

// #3 Unicidade no nível do banco: no máximo UMA aquisição por paciente.
// Parcial: só vale quando patient é ObjectId E isAcquisition=true — assim documentos
// legados (sem patient), linhas de não-aquisição e múltiplos patient=null não colidem.
adConversionSchema.index(
  { patient: 1 },
  {
    unique: true,
    name: 'uniq_acquisition_per_patient',
    partialFilterExpression: { patient: { $type: 'objectId' }, isAcquisition: true },
  }
);

export default mongoose.models.AdConversion || mongoose.model('AdConversion', adConversionSchema);
