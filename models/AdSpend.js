// models/AdSpend.js
// Gasto informado MANUALMENTE por anúncio/campanha (sem token de API de plataforma).
// A chave (adKey) é a mesma do card "Por anúncio": ID do anúncio de WhatsApp, marcador (TK-xxx)
// ou campanha do link do site. O card soma as entradas dentro do período escolhido.
import mongoose from 'mongoose';

const adSpendSchema = new mongoose.Schema({
  adKey: { type: String, required: true, index: true },
  amount: { type: Number, required: true, min: 0.01, max: 1000000 }, // BRL
  date: { type: Date, default: Date.now, index: true },              // dia a que o gasto se refere
  createdBy: { type: String, default: null },
}, { timestamps: true });

export default mongoose.models.AdSpend || mongoose.model('AdSpend', adSpendSchema);
