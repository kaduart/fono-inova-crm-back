// models/LeadAttribution.js
// Origem de marketing por TELEFONE (first-touch, nunca sobrescreve).
// Separado do Lead de propósito: capturar origem não pode criar Lead
// (evita disparar follow-up/recovery e duplicar leads).
import mongoose from 'mongoose';

const leadAttributionSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true, index: true }, // E.164 BR sem "+"
  source: { type: String, required: true },   // tiktok_ads | meta_ads | instagram_ads | google_ads | instagram | ...
  method: { type: String, enum: ['ctwa', 'site_signature', 'token', 'keyword', 'manual'], required: true },
  confidence: { type: String, enum: ['high', 'low'], default: 'low' },
  campaign: { type: String, default: null },
  utmSource: { type: String, default: null },
  gclid: { type: String, default: null },
  fbclid: { type: String, default: null },
  ttclid: { type: String, default: null },
  adId: { type: String, default: null },
  ctwaClid: { type: String, default: null },
  firstMessageAt: { type: Date, default: Date.now },
  capturedBy: { type: String, default: 'whatsapp_web' },
}, { timestamps: true });

export default mongoose.models.LeadAttribution || mongoose.model('LeadAttribution', leadAttributionSchema);
