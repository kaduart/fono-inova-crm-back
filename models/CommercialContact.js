// models/CommercialContact.js
// Registro de contato comercial feito pela equipe a partir das filas do Dashboard/Agenda
// (reativação, renovação de pacote, encaixe). Coleção própria: não altera Patient, Lead,
// Appointment nem Package. Ver docs/COMMERCIAL_QUEUES.md.
import mongoose from 'mongoose';

// churn = contato de reengajamento do alerta de evasão; churn_pause = pausa combinada
// com a família (férias, saúde), com fim em `until`. Ver docs/COMMERCIAL_QUEUES.md.
export const CONTACT_KINDS = ['reactivation', 'renewal', 'fit', 'lead_reply', 'evaluation', 'evaluation_lost', 'churn', 'churn_pause'];

const commercialContactSchema = new mongoose.Schema({
  targetType: { type: String, enum: ['patient', 'lead'], required: true },
  target: { type: mongoose.Schema.Types.ObjectId, required: true },
  kind: { type: String, enum: CONTACT_KINDS, required: true },
  channel: { type: String, enum: ['whatsapp', 'telefone', 'presencial'], default: 'whatsapp' },
  note: { type: String, default: '', maxlength: 500 },
  until: { type: Date, default: null }, // só em churn_pause
  // Só em lead_reply ("Marcar como respondido"): encaminhamento da Amanda a que a marcação se
  // refere (vale só para ele) e quem informou o fechamento. Ver docs/COMMERCIAL_QUEUES.md.
  handoffAt: { type: Date, default: undefined },
  closure: { type: String, enum: ['informado_pela_atendente'], default: undefined },
  waitKey: { type: String, default: undefined, maxlength: 120 }, // espera que a atendente viu na fila
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

commercialContactSchema.index({ target: 1, kind: 1, createdAt: -1 });

export default mongoose.models.CommercialContact
  || mongoose.model('CommercialContact', commercialContactSchema);
