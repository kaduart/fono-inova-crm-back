// models/AdConversion.js
// 1 documento por agendamento enviado às plataformas de anúncio.
// unique(appointment) = idempotência: nunca envia a mesma conversão 2x.
import mongoose from 'mongoose';

const platformSchema = new mongoose.Schema({
  status: { type: String, enum: ['pending', 'sent', 'skipped', 'failed'], default: 'pending' },
  sentAt: { type: Date, default: null },
  reason: { type: String, default: null },   // motivo do skip/falha (sem dados clínicos)
}, { _id: false });

const adConversionSchema = new mongoose.Schema({
  appointment: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', required: true, unique: true },
  phone: { type: String, default: null },
  source: { type: String, default: 'unknown' },
  attributionMethod: { type: String, default: null },
  adId: { type: String, default: null },       // anúncio de WhatsApp (ctwa) que originou a conversa
  campaign: { type: String, default: null },   // campanha/ID vindo do link do site (---ref)
  gclid: { type: String, default: null },
  fbc: { type: String, default: null },        // fb.1.<ms>.<fbclid> — identificador de clique da Meta
  value: { type: Number, default: 0 },
  eventTime: { type: Date, required: true },
  meta: { type: platformSchema, default: () => ({}) },
  google: { type: platformSchema, default: () => ({}) },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now, index: true },
  done: { type: Boolean, default: false, index: true },
}, { timestamps: true });

export default mongoose.models.AdConversion || mongoose.model('AdConversion', adConversionSchema);
