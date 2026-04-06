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
        type: Date,  // Date (data de referência do cálculo)
        required: true,
        index: true,
        set: function(v) {
            if (typeof v === 'string' && v.match(/^\d{4}-\d{2}-\d{2}$/)) {
                const [ano, mes, dia] = v.split('-').map(Number);
                return new Date(Date.UTC(ano, mes - 1, dia, 12, 0, 0));
            }
            return v;
        }
    },
    period: {
        type: String,  // day, week, month, year, custom
        default: 'month'
    },
    
    // 📅 Time Dimension (CRÍTICO para rastreabilidade)
    periodStart: {
        type: Date,
        required: true,
        description: 'Início do período de competência'
    },
    periodEnd: {
        type: Date,
        required: true,
        description: 'Fim do período de competência'
    },
    competencyDate: {
        type: Date,
        default: Date.now,
        description: 'Data de competência (quando a produção foi realizada)'
    },
    cashDate: {
        type: Date,
        default: Date.now,
        description: 'Data de caixa (quando o pagamento foi recebido)'
    },
    
    // Totais calculados (estrutura igual ao legado)
    totals: {
        // Geral
        totalReceived: { type: Number, default: 0 },        // 💰 Caixa real
        totalProduction: { type: Number, default: 0 },      // 📊 Tudo produzido
        totalPending: { type: Number, default: 0 },
        totalPartial: { type: Number, default: 0 },
        countReceived: { type: Number, default: 0 },
        countPending: { type: Number, default: 0 },
        countPartial: { type: Number, default: 0 },
        
        // Particular
        particularReceived: { type: Number, default: 0 },
        particularCountReceived: { type: Number, default: 0 },
        
        // Convênio
        insurance: {
            pendingBilling: { type: Number, default: 0 },
            billed: { type: Number, default: 0 },
            received: { type: Number, default: 0 }
        },
        totalInsuranceProduction: { type: Number, default: 0 },
        totalInsuranceReceived: { type: Number, default: 0 },
        totalInsurancePending: { type: Number, default: 0 },
        countInsuranceTotal: { type: Number, default: 0 },
        countInsuranceReceived: { type: Number, default: 0 },
        countInsurancePending: { type: Number, default: 0 },
        
        // 📦 NOVO: Crédito de Pacotes (Receita Diferida)
        packageCredit: {
            // 💰 Contrato e Caixa (semântica clara)
            contractedRevenue: { type: Number, default: 0 },   // 📄 Valor contratado (venda)
            cashReceived: { type: Number, default: 0 },        // 💰 Dinheiro efetivamente recebido
            // 📊 Receita Diferida (obrigação futura)
            deferredRevenue: { type: Number, default: 0 },     // 📊 Valor ainda não produzido
            deferredSessions: { type: Number, default: 0 },    // 📊 Sessões a cumprir
            // 📊 Receita Reconhecida (já executada)
            recognizedRevenue: { type: Number, default: 0 },   // 📊 Valor já produzido via pacote
            recognizedSessions: { type: Number, default: 0 },  // 📊 Sessões já realizadas
            totalSessions: { type: Number, default: 0 },       // 📊 Total de sessões vendidas
            activePackages: { type: Number, default: 0 }       // 📦 Pacotes ativos
        },
        
        // 📄 NOVO: Conta Corrente de Pacientes
        patientBalance: {
            totalDebt: { type: Number, default: 0 },        // 💰 A receber
            totalCredit: { type: Number, default: 0 },      // 📦 Crédito avulso
            totalDebited: { type: Number, default: 0 },     // Produção não paga
            totalCredited: { type: Number, default: 0 },    // Pagamentos recebidos
            patientsWithDebt: { type: Number, default: 0 },
            patientsWithCredit: { type: Number, default: 0 }
        },
        
        // 💸 NOVO: Despesas e Lucro
        expenses: {
            total: { type: Number, default: 0 },            // 💸 Despesas pagas
            pending: { type: Number, default: 0 },          // ⏳ Despesas pendentes
            count: { type: Number, default: 0 }             // 📊 Quantidade de despesas
        },
        profit: { type: Number, default: 0 },               // 💰 Lucro (receita - despesas)
        profitMargin: { type: Number, default: 0 },         // 📈 Margem de lucro (%)
        
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
    
    // 🔍 Validações de consistência (severidade: error, warning, insight)
    validations: [{
        type: {
            type: String,
            enum: ['error', 'warning', 'insight'],
            required: true
        },
        code: {
            type: String,
            required: true
        },
        message: String,
        details: mongoose.Schema.Types.Mixed,
        timestamp: {
            type: Date,
            default: Date.now
        }
    }],
    
    // 🚨 Bloqueios críticos (impedem uso do snapshot)
    blockingErrors: [{
        code: String,
        message: String,
        field: String,
        expected: mongoose.Schema.Types.Mixed,
        actual: mongoose.Schema.Types.Mixed
    }],
    
    // 📊 Insights gerenciais (sugestões, não alertas)
    insights: [{
        type: {
            type: String,
            enum: ['capacity', 'trend', 'opportunity', 'risk']
        },
        code: String,
        message: String,
        value: Number,
        threshold: Number
    }],
    
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
