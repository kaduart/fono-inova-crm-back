/**
 * 🏦 FINANCIAL LEDGER - Livro Razão Contábil
 * 
 * Princípio: NUNCA ALTERAR, SÓ LANÇAR
 * Cada movimentação financeira é registrada como um lançamento imutável.
 * 
 * Isso permite:
 * - Auditoria total (quem, quando, quanto)
 * - Reconciliação automática
 * - Cashflow confiável
 * - Zero divergência
 */

import mongoose from 'mongoose';

const ledgerSchema = new mongoose.Schema({
    // 📝 Tipo de lançamento
    type: {
        type: String,
        required: true,
        enum: [
            'payment_received',      // 💰 Entrada - pagamento recebido
            'payment_pending',       // ⏳ A receber - pagamento pendente
            'refund',                // ↩️ Saída - estorno
            'adjustment',            // 🔧 Ajuste manual (correção)
            'package_purchase',      // 📦 Entrada - compra de pacote
            'package_consumed',      // 🎯 Reconhecimento - sessão consumida
            'revenue_recognition',   // 📈 Reconhecimento de receita
            'write_off',             // 🗑️ Baixa - perda/dívida incobrável
            'transfer'               // 🔄 Transferência entre contas
        ]
    },

    // ⬆️⬇️ Direção: credit = entra dinheiro, debit = sai dinheiro
    direction: {
        type: String,
        required: true,
        enum: ['credit', 'debit']
    },

    // 💵 Valor (sempre positivo, a direção indica se é entrada ou saída)
    amount: {
        type: Number,
        required: true,
        min: 0
    },

    // 🔗 Relacionamentos
    patient: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Patient',
        index: true 
    },
    appointment: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Appointment',
        index: true 
    },
    session: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Session',
        index: true 
    },
    payment: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Payment',
        index: true 
    },
    package: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Package',
        index: true
    },

    // 🆔 Rastreabilidade
    correlationId: { 
        type: String, 
        required: true,
        index: true 
    },

    // 📋 Descrição legível
    description: {
        type: String,
        default: ''
    },

    // 📎 Metadados extras
    metadata: {
        source: { type: String },           // ex: 'appointment_complete', 'manual_adjustment'
        reason: { type: String },           // ex: 'Pacote pré-pago', 'Estorno solicitado'
        previousStatus: { type: String },   // para ajustes
        newStatus: { type: String },        // para ajustes
        ip: { type: String },               // IP do usuário
        userAgent: { type: String }         // User agent
    },

    // ⏰ Datas
    occurredAt: { 
        type: Date, 
        required: true,
        index: true 
    }, // Quando o evento financeiro ocorreu
    
    recordedAt: { 
        type: Date, 
        default: Date.now 
    }, // Quando foi registrado no sistema

    // 👤 Auditoria
    createdBy: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'User' 
    },
    
    createdByName: {
        type: String,
        default: ''
    }

}, { 
    timestamps: true,
    collection: 'financial_ledger'
});

// ============ ÍNDICES DE PERFORMANCE ============

// 🔒 IDEMPOTÊNCIA: Garante que não duplica lançamento com mesmo correlationId+tipo
ledgerSchema.index(
    { correlationId: 1, type: 1 },
    { unique: true, partialFilterExpression: { correlationId: { $exists: true } } }
);

// Busca por período (cashflow)
ledgerSchema.index({ occurredAt: 1, direction: 1 });

// Busca por paciente + período
ledgerSchema.index({ patient: 1, occurredAt: -1 });

// Busca por tipo + período
ledgerSchema.index({ type: 1, occurredAt: -1 });

// Reconciliação
ledgerSchema.index({ payment: 1, type: 1 });

// ============ BLOQUEIO TOTAL DE ALTERAÇÃO ============
// 🚨 LEDGER É IMUTÁVEL - NUNCA PODE SER ALTERADO

ledgerSchema.pre('updateOne', function(next) {
    const error = new Error(
        '[AUDIT LOCK] FinancialLedger é IMUTÁVEL. ' +
        'Não é permitido alterar lançamentos contábeis. ' +
        'Para corrigir, crie um lançamento de ajuste (type: adjustment)'
    );
    error.code = 'LEDGER_IMMUTABLE';
    next(error);
});

ledgerSchema.pre('updateMany', function(next) {
    const error = new Error(
        '[AUDIT LOCK] FinancialLedger é IMUTÁVEL. ' +
        'Operações em massa não são permitidas.'
    );
    error.code = 'LEDGER_IMMUTABLE';
    next(error);
});

ledgerSchema.pre('findOneAndUpdate', function(next) {
    const error = new Error(
        '[AUDIT LOCK] FinancialLedger é IMUTÁVEL. ' +
        'Não é permitido alterar lançamentos contábeis.'
    );
    error.code = 'LEDGER_IMMUTABLE';
    next(error);
});

ledgerSchema.pre('deleteOne', function(next) {
    const error = new Error(
        '[AUDIT LOCK] FinancialLedger é IMUTÁVEL. ' +
        'Não é permitido excluir lançamentos contábeis.'
    );
    error.code = 'LEDGER_IMMUTABLE';
    next(error);
});

ledgerSchema.pre('deleteMany', function(next) {
    const error = new Error(
        '[AUDIT LOCK] FinancialLedger é IMUTÁVEL. ' +
        'Exclusão em massa não é permitida.'
    );
    error.code = 'LEDGER_IMMUTABLE';
    next(error);
});

// ============ MÉTODOS ESTÁTICOS ============

/**
 * Cria um lançamento de entrada (crédito)
 */
ledgerSchema.statics.credit = async function(data, mongoSession) {
    const entry = new this({
        ...data,
        direction: 'credit'
    });
    return entry.save({ session: mongoSession });
};

/**
 * Cria um lançamento de saída (débito)
 */
ledgerSchema.statics.debit = async function(data, mongoSession) {
    const entry = new this({
        ...data,
        direction: 'debit'
    });
    return entry.save({ session: mongoSession });
};

/**
 * Cria um lançamento de ajuste (crédito + débito em sequência)
 * Usado para correções
 */
ledgerSchema.statics.adjustment = async function(data, mongoSession) {
    const { originalAmount, newAmount, ...common } = data;
    const difference = newAmount - originalAmount;
    
    const entries = [];
    
    if (difference > 0) {
        // Aumento = crédito
        entries.push(await this.credit({
            ...common,
            type: 'adjustment',
            amount: difference,
            description: `Ajuste: aumento de ${originalAmount} para ${newAmount}`
        }, mongoSession));
    } else if (difference < 0) {
        // Redução = débito
        entries.push(await this.debit({
            ...common,
            type: 'adjustment',
            amount: Math.abs(difference),
            description: `Ajuste: redução de ${originalAmount} para ${newAmount}`
        }, mongoSession));
    }
    
    return entries;
};

/**
 * Reconciliação: soma todos os créditos - débitos
 */
ledgerSchema.statics.reconcile = async function(filters = {}) {
    const result = await this.aggregate([
        { $match: filters },
        {
            $group: {
                _id: '$direction',
                total: { $sum: '$amount' }
            }
        }
    ]);
    
    const credit = result.find(r => r._id === 'credit')?.total || 0;
    const debit = result.find(r => r._id === 'debit')?.total || 0;
    
    return {
        credit,
        debit,
        balance: credit - debit
    };
};

/**
 * Cashflow por período
 */
ledgerSchema.statics.cashflow = async function(startDate, endDate, filters = {}) {
    return this.aggregate([
        {
            $match: {
                occurredAt: { $gte: startDate, $lte: endDate },
                ...filters
            }
        },
        {
            $group: {
                _id: {
                    date: { $dateToString: { format: '%Y-%m-%d', date: '$occurredAt' } },
                    direction: '$direction'
                },
                total: { $sum: '$amount' },
                count: { $sum: 1 }
            }
        },
        { $sort: { '_id.date': 1 } }
    ]);
};

const FinancialLedger = mongoose.model('FinancialLedger', ledgerSchema);

export default FinancialLedger;
