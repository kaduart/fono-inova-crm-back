// models/DailyClosing.js
/**
 * Modelo para armazenar resultado do fechamento diário
 * Processado pelo worker, lido pela API
 */

import mongoose from 'mongoose';

const DailyClosingSchema = new mongoose.Schema({
    date: {
        type: String,
        required: true,
        index: true
    },
    clinicId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Clinic',
        index: true
    },
    
    // Resumo calculado
    summary: {
        appointments: {
            total: { type: Number, default: 0 },
            attended: { type: Number, default: 0 },
            canceled: { type: Number, default: 0 },
            pending: { type: Number, default: 0 }
        },
        payments: {
            total: { type: Number, default: 0 },
            totalAmount: { type: Number, default: 0 }
        }
    },
    
    // Dados detalhados (simplificados)
    appointments: [{
        id: String,
        patient: String,
        doctor: String,
        status: String,
        sessionValue: Number
    }],
    
    payments: [{
        id: String,
        amount: Number,
        method: String,
        patient: String
    }],
    
    // Metadados do processamento
    processedAt: {
        type: Date,
        default: Date.now
    },
    processedBy: {
        type: String,
        default: 'system'
    },
    
    // TTL: Auto-expira após 90 dias (dados históricos)
    expiresAt: {
        type: Date,
        default: () => new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
    }
}, {
    timestamps: true
});

// Índice composto único: um fechamento por dia por clínica
DailyClosingSchema.index({ date: 1, clinicId: 1 }, { unique: true });

// Índice TTL para auto-expiração
DailyClosingSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('DailyClosing', DailyClosingSchema);
