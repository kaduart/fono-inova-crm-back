// models/FinancialEvent.js
// 🏥 ARQUITETURA v4.0 - Audit Trail Financeiro Imutável
// Coleção capped para auditoria de alta performance

import mongoose from 'mongoose';

const financialEventSchema = new mongoose.Schema({
    eventType: {
        type: String,
        enum: ['SESSION_COMPLETED', 'PAYMENT_CREATED', 'BALANCE_DEBITED', 
               'BALANCE_CREDITED', 'PACKAGE_CONSUMED', 'INSURANCE_RECEIVABLE_CREATED',
               'COMMISSION_CALCULATED', 'REVENUE_RECOGNIZED'],
        required: true,
        index: true
    },
    
    timestamp: { 
        type: Date, 
        default: Date.now, 
        index: true 
    },
    
    // IDs relacionados
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', index: true },
    appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', index: true },
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', index: true },
    packageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Package' },
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },
    
    // Dados do evento (snapshot para auditoria)
    payload: {
        paymentType: String,
        amount: Number,
        previousBalance: Number,
        newBalance: Number,
        sessionsRemaining: Number,
        sessionsDone: Number,
        commissionValue: Number,
        metadata: mongoose.Schema.Types.Mixed
    },
    
    // Rastreabilidade
    correlationId: { 
        type: String, 
        index: true,
        description: 'ID para rastrear transações distribuídas'
    },
    
    processedBy: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'User' 
    },
    
    ipAddress: String,
    userAgent: String
}, { 
    timestamps: false  // Usamos timestamp customizado
});

// Índices compostos para queries comuns
financialEventSchema.index({ patientId: 1, timestamp: -1 });
financialEventSchema.index({ eventType: 1, timestamp: -1 });
financialEventSchema.index({ correlationId: 1, timestamp: -1 });

const FinancialEvent = mongoose.model('FinancialEvent', financialEventSchema);

export default FinancialEvent;
