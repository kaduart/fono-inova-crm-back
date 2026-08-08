import mongoose from 'mongoose';

// Contador atômico por prestador/série. Números consumidos não são reutilizados, mesmo quando
// uma tentativa falha, evitando colisão de identificadores perante a Sefin Nacional.
const fiscalDpsSequenceSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, index: true },
  value: { type: Number, required: true, default: 0, min: 0 }
}, { timestamps: true });

const FiscalDpsSequence = mongoose.models.FiscalDpsSequence || mongoose.model('FiscalDpsSequence', fiscalDpsSequenceSchema);
export default FiscalDpsSequence;
