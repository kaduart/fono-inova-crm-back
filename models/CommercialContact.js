// models/CommercialContact.js
// Registro de contato comercial feito pela equipe a partir das filas do Dashboard/Agenda
// (reativação, renovação de pacote, encaixe). Coleção própria: não altera Patient, Lead,
// Appointment nem Package. Ver docs/COMMERCIAL_QUEUES.md.
import mongoose from 'mongoose';

const commercialContactSchema = new mongoose.Schema({
  targetType: { type: String, enum: ['patient', 'lead'], required: true },
  target: { type: mongoose.Schema.Types.ObjectId, required: true },
  kind: { type: String, enum: ['reactivation', 'renewal', 'fit', 'lead_reply'], required: true },
  channel: { type: String, enum: ['whatsapp', 'telefone', 'presencial'], default: 'whatsapp' },
  note: { type: String, default: '', maxlength: 500 },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

commercialContactSchema.index({ target: 1, kind: 1, createdAt: -1 });

export default mongoose.models.CommercialContact
  || mongoose.model('CommercialContact', commercialContactSchema);
