// models/ConfiguracaoFiscal.js
import mongoose from 'mongoose';

const configuracaoFiscalSchema = new mongoose.Schema({
    regimeTributario: {
        type: String,
        enum: ['SIMPLES_NACIONAL', 'LUCRO_PRESUMIDO', 'LUCRO_REAL'],
        default: 'SIMPLES_NACIONAL'
    },
    aliquotas: {
        simples: { type: Number, default: 6.00 },      // 6%
        pis: { type: Number, default: 0.65 },          // 0,65%
        cofins: { type: Number, default: 3.00 },       // 3%
        irpj: { type: Number, default: 4.80 },         // 4,8%
        csll: { type: Number, default: 2.88 },         // 2,88%
        icms: { type: Number, default: 0 }
    },
    vigencia: {
        inicio: { type: Date, required: true },
        fim: { type: Date }
    },
    ativo: { type: Boolean, default: true }
}, { timestamps: true });

export default mongoose.model('ConfiguracaoFiscal', configuracaoFiscalSchema);