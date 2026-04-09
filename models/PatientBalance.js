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
    // 🆕 ESPECIALIDADE (essencial para filtro por tipo)
    specialty: {
        type: String,
        default: null,
        description: 'Especialidade do atendimento (fonoaudiologia, psicologia, terapia_ocupacional, etc)'
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
    },
    // 🆕 V3: Link com pacote que quitou este débito
    settledByPackageId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Package',
        default: null,
        description: 'ID do pacote que quitou este débito (evita duplicidade)'
    },
    // 🆕 V4: ID de correlação para idempotência (1 appointment = 1 débito)
    correlationId: {
        type: String,
        default: null,
        index: true,
        description: 'ID de correlação para evitar duplicidade de débitos'
    },
    // 🆕 V4: Controle de concorrência - marca transações em processamento
    processingLock: {
        type: String,
        default: null,
        description: 'Lock temporário para prevenir race conditions'
    },
    lockedAt: {
        type: Date,
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

// 🛡️ INDEXES para prevenir duplicidades e melhorar performance
// NOTA: Unique indexes são gerenciados pelo script add-unique-indexes.js
// pois MongoDB não suporta unique constraint em campos de subdocumentos (transactions)
// sem schema validation adicional.
patientBalanceSchema.index({ patient: 1, 'transactions.appointmentId': 1 });
patientBalanceSchema.index({ patient: 1, 'transactions.specialty': 1 });
patientBalanceSchema.index({ patient: 1, 'transactions.settledByPackageId': 1 });
patientBalanceSchema.index({ patient: 1, 'transactions.correlationId': 1 });

// Virtual para saber se tem saldo devedor
patientBalanceSchema.virtual('hasDebt').get(function() {
    return this.currentBalance > 0;
});

// Virtual para saber se tem crédito (saldo a favor)
patientBalanceSchema.virtual('hasCredit').get(function() {
    return this.currentBalance < 0;
});

// Método para adicionar débito (sessão usada não paga) - IDEMPOTENTE
patientBalanceSchema.methods.addDebit = async function(
    amount, 
    description, 
    sessionId = null, 
    appointmentId = null, 
    registeredBy = null,
    specialty = null,  // 🆕 especialidade do atendimento
    correlationId = null  // 🆕 V4: ID de correlação para idempotência
) {
    console.log(`[PatientBalance.addDebit] Iniciando - amount: ${amount}, patient: ${this.patient}, specialty: ${specialty}, correlationId: ${correlationId}`);
    
    // 🔥 IDEMPOTÊNCIA: Verificar se já existe débito para este appointment
    if (appointmentId) {
        const exists = this.transactions.find(t => 
            t.type === 'debit' && 
            t.appointmentId?.toString() === appointmentId.toString()
        );
        
        if (exists) {
            console.log(`[PatientBalance.addDebit] ⚠️ Débito já existe para appointment ${appointmentId}, ignorando...`);
            return { skipped: true, reason: 'already_exists', transaction: exists };
        }
    }
    
    // 🔥 IDEMPOTÊNCIA: Verificar por correlationId
    if (correlationId) {
        const existsByCorrelation = this.transactions.find(t => 
            t.type === 'debit' && 
            t.correlationId === correlationId
        );
        
        if (existsByCorrelation) {
            console.log(`[PatientBalance.addDebit] ⚠️ Débito já existe para correlationId ${correlationId}, ignorando...`);
            return { skipped: true, reason: 'correlation_exists', transaction: existsByCorrelation };
        }
    }
    
    // Normaliza specialty (igual ao Session)
    const normalizedSpecialty = specialty 
        ? specialty.toString().toLowerCase().trim().replace(/_/g, ' ').replace(/\s+/g, ' ')
        : null;
    
    this.transactions.push({
        type: 'debit',
        amount,
        description,
        sessionId,
        appointmentId,
        specialty: normalizedSpecialty,
        correlationId,  // 🆕 V4: guarda correlationId
        registeredBy,
        transactionDate: new Date()
    });
    
    this.currentBalance += amount;
    this.totalDebited += amount;
    this.lastTransactionAt = new Date();
    
    console.log(`[PatientBalance.addDebit] Salvando... Novo saldo: ${this.currentBalance}, specialty: ${normalizedSpecialty}`);
    const result = await this.save();
    console.log(`[PatientBalance.addDebit] ✅ Salvo com sucesso`);
    return { skipped: false, transaction: result.transactions[result.transactions.length - 1] };
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
