// models/FiscalSnapshot.js
// A própria DPS enviada é um snapshot (Fase 2 v3, Seção 2.7) — precisa sobreviver a mudanças
// futuras nos dados de origem (endereço do paciente, configuração fiscal). 1:1 com FiscalSubmission:
// cada tentativa gera seu próprio snapshot, já que uma correção entre tentativas muda o conteúdo.
// Imutável (invariante #15) — nunca regenerado/sobrescrito.
import mongoose from 'mongoose';

const fiscalSnapshotSchema = new mongoose.Schema({
  fiscalSubmission: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'FiscalSubmission',
    required: true,
    unique: true,
    index: true
  },
  xml: { type: String },
  json: { type: mongoose.Schema.Types.Mixed },
  hash: { type: String, required: true },
  // Versão do leiaute/XSD usado (ex. Anexo I v1.01-20260209) — distinto de providerVersion
  // (ProviderTransaction, o que o webservice respondeu usar)
  schemaVersion: { type: String, required: true },
  // Versão do manual oficial seguido pelo DpsBuilder no momento (rastreabilidade quando a
  // documentação oficial mudar)
  manualVersion: { type: String }
}, { timestamps: true });

const FiscalSnapshot = mongoose.models.FiscalSnapshot || mongoose.model('FiscalSnapshot', fiscalSnapshotSchema);
export default FiscalSnapshot;
