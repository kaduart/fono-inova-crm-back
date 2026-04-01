// models/TotalsSnapshot.js
/**
 * Snapshot de totais financeiros
 * Calculado pelo worker, lido pela API (leitura rápida)
 */

import mongoose from 'mongoose';

const TotalsSnapshotSchema = new mongoose.Schema({
    // Identificação
    clinicId: {
        type: String,
        required: true,
        index: true
    },
    date: {
        type: String,  // YYYY-MM-DD
        required: true,
        index: true
    },
    period: {
        type: String,  // day, week, month, year, custom
        default: 'month'
    },
    
    // Totais calculados (estrutura igual ao legado)
    totals: {
        // Geral
        totalReceived: { type: Number, default: 0 },
        totalPending: { type: Number, default: 0 },
        totalPartial: { type: Number, default: 0 },
        countReceived: { type: Number, default: 0 },
        countPending: { type: Number, default: 0 },
        countPartial: { type: Number, default: 0 },
        
        // Particular
        particularReceived: { type: Number, default: 0 },
        particularCountReceived: { type: Number, default: 0 },
        
        // Convênio
        totalInsuranceProduction: { type: Number, default: 0 },
        totalInsuranceReceived: { type: Number, default: 0 },
        totalInsurancePending: { type: Number, default: 0 },
        countInsuranceTotal: { type: Number, default: 0 },
        countInsuranceReceived: { type: Number, default: 0 },
        countInsurancePending: { type: Number, default: 0 },
        
        // Por método de pagamento
        byMethod: {
            dinheiro: { amount: Number, count: Number },
            pix: { amount: Number, count: Number },
            cartao_credito: { amount: Number, count: Number },
            cartao_debito: { amount: Number, count: Number },
            convenio: { amount: Number, count: Number }
        }
    },
    
    // Metadados
    calculatedAt: {
        type: Date,
        default: Date.now
    },
    calculatedBy: {
        type: String,
        default: 'totals_worker'
    },
    
    // TTL: Auto-expira após 7 dias (será recalculado)
    expiresAt: {
        type: Date,
        default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    }
}, {
    timestamps: true
});

// Índice composto único: um snapshot por clínica/data/período
TotalsSnapshotSchema.index({ clinicId: 1, date: 1, period: 1 }, { unique: true });

// Índice TTL para auto-expiração
TotalsSnapshotSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Índice para consultas rápidas
TotalsSnapshotSchema.index({ clinicId: 1, calculatedAt: -1 });

export default mongoose.model('TotalsSnapshot', TotalsSnapshotSchema);
