// models/schemas/CommunicationRuleSchema.js
// Regras de documentos obrigatórios para envio de comunicação por convênio.
import mongoose from 'mongoose';

const requiredDocumentSchema = new mongoose.Schema({
  type: {
    type: String,
    required: true
  },
  label: {
    type: String,
    required: true
  },
  required: {
    type: Boolean,
    default: true
  }
}, { _id: true });

const communicationRuleSchema = new mongoose.Schema({
  // E-mail padrão para envio
  defaultEmail: {
    type: String,
    default: '',
    trim: true
  },
  // Assunto padrão
  defaultSubject: {
    type: String,
    default: 'Solicitação',
    trim: true
  },
  // Documentos obrigatórios/sugeridos para envio
  requiredDocuments: [requiredDocumentSchema],
  // Observações internas
  notes: {
    type: String,
    default: '',
    trim: true
  }
}, { _id: false });

export default communicationRuleSchema;
