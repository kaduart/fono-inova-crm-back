import mongoose from 'mongoose';


const leadSchema = new mongoose.Schema({
  name: { type: String, required: true },
  contact: {
    email: { type: String, required: false },
    phone: { type: String, required: false }
  },
  origin: { type: String, enum: ['WhatsApp', 'Site', 'Indicação', 'Outro'], default: 'Outro' },
  status: { type: String, enum: ['novo', 'atendimento', 'convertido', 'perdido'], default: 'novo' },
  interactions: [
    {
      date: { type: Date, default: Date.now },
      note: { type: String }
    }
  ]
}, { timestamps: true });

const Leads = mongoose.model('Leads', leadSchema);

export default Leads;
