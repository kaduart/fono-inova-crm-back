// models/PatientBalance.js
// Sistema de conta corrente - controla sessões usadas mas não pagas
import mongoose from 'mongoose';

const balanceTransactionSchema = new mongoose.Schema({
    type: {
        type: String,
        enum: ['debit', 'credit', 'payment'],
        required: true
    },
    amount: {
        type: Number,
        required: true,
        min: 0
    },
    description: {
        type: String,
        required: true
    },
    // Referência à sessão/agendamento (opcional)
    sessionId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Session',
        default: null
    },
    appointmentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Appointment',
        default: null
    },
    // Quem registrou
    registeredBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    // Para pagamentos: método usado
    paymentMethod: {
        type: String,
        enum: ['dinheiro', 'pix', 'cartao_credito', 'cartao_debito', 'transferencia_bancaria', 'credito', 'debito', 'transferencia', null],
        default: null
    },
    // Data da transação
    transactionDate: {
        type: Date,
        default: Date.now
    },
    // Para débitos: quanto já foi pago (para controle de pagamentos parciais)
    paidAmount: {
        type: Number,
        default: 0
    },
    // Para débitos: se está totalmente quitado
    isPaid: {
        type: Boolean,
        default: false
    },
    // Para pagamentos: ID do débito que foi pago
    linkedDebitId: {
        type: mongoose.Schema.Types.ObjectId,
        default: null
    },
    // 🚀 V2: Soft delete
    isDeleted: {
        type: Boolean,
        default: false
    },
    deletedAt: {
        type: Date,
        default: null
    },
    deletedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    deleteReason: {
        type: String,
        default: null
    }
}, { _id: true });

const patientBalanceSchema = new mongoose.Schema({
    patient: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Patient',
        required: true,
        unique: true, // Um registro por paciente
        index: true
    },
    // Saldo atual (positivo = devedor, negativo = credor)
    currentBalance: {
        type: Number,
        default: 0
    },
    // Histórico de transações
    transactions: [balanceTransactionSchema],
    // Metadados
    lastTransactionAt: {
        type: Date,
        default: null
    },
    // Total acumulado de débitos (para estatísticas)
    totalDebited: {
        type: Number,
        default: 0
    },
    // Total acumulado de pagamentos/créditos
    totalCredited: {
        type: Number,
        default: 0
    },
    // 🚀 V2: Processing status
    processingStatus: {
        type: String,
        enum: ['idle', 'updating', 'error'],
        default: 'idle'
    }
}, {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
});

// Virtual para saber se tem saldo devedor
patientBalanceSchema.virtual('hasDebt').get(function() {
    return this.currentBalance > 0;
});

// Virtual para saber se tem crédito (saldo a favor)
patientBalanceSchema.virtual('hasCredit').get(function() {
    return this.currentBalance < 0;
});

// Método para adicionar débito (sessão usada não paga)
patientBalanceSchema.methods.addDebit = async function(amount, description, sessionId = null, appointmentId = null, registeredBy = null) {
    console.log(`[PatientBalance.addDebit] Iniciando - amount: ${amount}, patient: ${this.patient}`);
    
    this.transactions.push({
        type: 'debit',
        amount,
        description,
        sessionId,
        appointmentId,
        registeredBy,
        transactionDate: new Date()
    });
    
    this.currentBalance += amount;
    this.totalDebited += amount;
    this.lastTransactionAt = new Date();
    
    console.log(`[PatientBalance.addDebit] Salvando... Novo saldo: ${this.currentBalance}`);
    const result = await this.save();
    console.log(`[PatientBalance.addDebit] ✅ Salvo com sucesso`);
    return result;
};

// Método para registrar pagamento/crédito
patientBalanceSchema.methods.addPayment = async function(amount, paymentMethod, description, registeredBy = null) {
    this.transactions.push({
        type: 'payment',
        amount,
        description: description || 'Pagamento de saldo devedor',
        paymentMethod,
        registeredBy,
        transactionDate: new Date()
    });
    
    this.currentBalance -= amount;
    this.totalCredited += amount;
    this.lastTransactionAt = new Date();
    
    return await this.save();
};

// Método para adicionar crédito (ex: sessão cancelada com reembolso)
patientBalanceSchema.methods.addCredit = async function(amount, description, registeredBy = null) {
    this.transactions.push({
        type: 'credit',
        amount,
        description,
        registeredBy,
        transactionDate: new Date()
    });
    
    this.currentBalance -= amount;
    this.totalCredited += amount;
    this.lastTransactionAt = new Date();
    
    return await this.save();
};

// Método estático para obter ou criar saldo do paciente
patientBalanceSchema.statics.getOrCreate = async function(patientId) {
    let balance = await this.findOne({ patient: patientId });
    if (!balance) {
        balance = await this.create({ patient: patientId });
    }
    return balance;
};

const PatientBalance = mongoose.model('PatientBalance', patientBalanceSchema);
export default PatientBalance;
