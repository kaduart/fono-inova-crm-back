// models/FiscalProfile.js
// Nível intermediário entre a empresa e o certificado/config fiscal (Fase 2 v3, Seção 2.3).
// Suporta múltiplos CNPJs/municípios sem exigir refatoração — hoje a clínica opera com 1 único
// FiscalProfile ativo, mas o custo de já modelar como coleção (não singleton) é baixo.
import mongoose from 'mongoose';
import { RegimeTributario, FiscalAmbiente } from '../constants/fiscalEnums.js';

const fiscalProfileSchema = new mongoose.Schema({
  cnpj: { type: String, required: true, index: true },
  razaoSocial: { type: String, required: true },
  // Alimenta o FiscalProviderResolver (Fase 2 v3, Seção 4.3) — critério primário de resolução
  municipioIBGE: { type: String, required: true, index: true },
  cnae: { type: String },
  codigoServicoLC116: { type: String }, // cTribNac — ex. 040803 Fonoaudiologia
  inscricaoMunicipal: { type: String },
  // Mesmo enum de models/ConfiguracaoFiscal.js — decisão de reaproveitar essa fonte ainda em aberto
  // (Fase 2 v3, Seção 0 e Seção 12, item 1)
  regimeTributario: {
    type: String,
    enum: Object.values(RegimeTributario)
  },
  ambiente: {
    type: String,
    enum: Object.values(FiscalAmbiente),
    default: FiscalAmbiente.PRODUCAO_RESTRITA
  },
  certificateRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Certificate' },
  ativo: { type: Boolean, default: true, index: true }
}, { timestamps: true });

fiscalProfileSchema.index({ cnpj: 1, ativo: 1 });

const FiscalProfile = mongoose.models.FiscalProfile || mongoose.model('FiscalProfile', fiscalProfileSchema);
export default FiscalProfile;
