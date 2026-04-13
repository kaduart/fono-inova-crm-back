import mongoose from 'mongoose';

/**
 * 💰 Financial Projection
 * 
 * Dados pré-calculados para dashboard financeiro.
 * Atualizado via eventos - não calcula em tempo real.
 */
const financialProjectionSchema = new mongoose.Schema({
    // Período (ex: "2026-04")
    month: { type: String, required: true, index: true },
    
    // Tipo de dados: 'cash' | 'expenses' | 'production'
    type: { 
        type: String, 
        required: true, 
        enum: ['cash', 'expenses', 'production'],
        index: true 
    },
    
    // Dados agregados
    data: {
        total: { type: Number, default: 0 },
        byBillingType: {
            particular: { type: Number, default: 0 },
            convenio: { type: Number, default: 0 },
            insurance: { type: Number, default: 0 }
        },
        byMethod: {
            pix: { type: Number, default: 0 },
            cartao: { type: Number, default: 0 },
            dinheiro: { type: Number, default: 0 },
            convenio: { type: Number, default: 0 }
        },
        byCategory: { type: Map, of: Number, default: {} } // Para despesas
    },
    
    // Metadados
    metadata: {
        count: { type: Number, default: 0 },
        failedCount: { type: Number, default: 0 },
        lastPaymentAt: { type: Date },
        lastPaymentId: { type: String },
        recentPayments: [{ 
            paymentId: String, 
            amount: Number, 
            billingType: String,
            date: Date 
        }],
        updatedAt: { type: Date, default: Date.now }
    }
}, { 
    timestamps: true,
    // Índice composto único
    index: { month: 1, type: 1 },
    // TTL: mantém só 2 anos (opcional)
    // expires: 730 * 24 * 60 * 60 
});

// Índices para queries comuns
financialProjectionSchema.index({ month: 1, type: 1 }, { unique: true });
financialProjectionSchema.index({ 'metadata.updatedAt': -1 });

const FinancialProjection = mongoose.model('FinancialProjection', financialProjectionSchema);

export default FinancialProjection;
