// models/DetectorFeedback.js
// 🎯 FASE 4: Tracking individual de detecções dos detectores contextuais
// Integra com infraestrutura existente de learning

import mongoose from 'mongoose';

const detectorFeedbackSchema = new mongoose.Schema({
    // ═══════════════════════════════════════════════════
    // 🎯 IDENTIFICAÇÃO DA DETECÇÃO
    // ═══════════════════════════════════════════════════
    detector: {
        type: String,
        enum: ['price', 'scheduling', 'confirmation', 'insurance'],
        required: true,
        index: true
    },

    pattern: {
        type: String, // 'objection', 'urgency', 'insistence', etc
        required: true,
        index: true
    },

    // ═══════════════════════════════════════════════════
    // 📝 DADOS DA DETECÇÃO
    // ═══════════════════════════════════════════════════
    text: {
        type: String,
        required: true
    },

    confidence: {
        type: Number,
        required: true,
        min: 0,
        max: 1
    },

    detectedAt: {
        type: Date,
        default: Date.now,
        index: true
    },

    // ═══════════════════════════════════════════════════
    // 🔗 CONTEXTO
    // ═══════════════════════════════════════════════════
    lead: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Lead',
        required: true,
        index: true
    },

    message: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Message'
    },

    therapyArea: String,
    stage: String,

    // Strategic hint que foi aplicado (FASE 3)
    strategicHint: {
        tone: String,
        approach: String,
        priority: String
    },

    // ═══════════════════════════════════════════════════
    // 📊 OUTCOME (preenchido depois)
    // ═══════════════════════════════════════════════════
    outcome: {
        recorded: {
            type: Boolean,
            default: false,
            index: true
        },

        // Lead converteu? (agendou)
        converted: Boolean,

        // Tempo até conversão (em minutos)
        timeToConversion: Number,

        // Contexto estava correto?
        contextCorrect: Boolean,

        // Detecção foi útil para conversão?
        detectionUseful: Boolean,

        // Timestamp do outcome
        recordedAt: Date,

        // Métricas específicas por detector
        specificMetrics: mongoose.Schema.Types.Mixed
    }
}, {
    timestamps: true,
    collection: 'detector_feedbacks'
});

// ═══════════════════════════════════════════════════
// 📊 ÍNDICES PARA QUERIES RÁPIDAS
// ═══════════════════════════════════════════════════
detectorFeedbackSchema.index({ detector: 1, pattern: 1, createdAt: -1 });
detectorFeedbackSchema.index({ lead: 1, createdAt: -1 });
detectorFeedbackSchema.index({ 'outcome.recorded': 1, 'outcome.converted': 1 });
detectorFeedbackSchema.index({ detector: 1, 'outcome.recorded': 1, createdAt: -1 });

// ═══════════════════════════════════════════════════
// 🔍 MÉTODOS ESTÁTICOS
// ═══════════════════════════════════════════════════

/**
 * Busca feedbacks pendentes de outcome para um lead
 */
detectorFeedbackSchema.statics.findPendingByLead = function(leadId) {
    return this.find({
        lead: leadId,
        'outcome.recorded': false
    }).sort({ createdAt: -1 });
};

/**
 * Busca feedbacks de um detector específico (últimos N dias)
 */
detectorFeedbackSchema.statics.findByDetector = function(detector, days = 30) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return this.find({
        detector,
        'outcome.recorded': true,
        createdAt: { $gte: since }
    }).sort({ createdAt: -1 });
};

/**
 * Calcula taxa de conversão de um padrão específico
 */
detectorFeedbackSchema.statics.calculateConversionRate = async function(detector, pattern, days = 30) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const total = await this.countDocuments({
        detector,
        pattern,
        'outcome.recorded': true,
        createdAt: { $gte: since }
    });

    if (total === 0) return null;

    const converted = await this.countDocuments({
        detector,
        pattern,
        'outcome.recorded': true,
        'outcome.converted': true,
        createdAt: { $gte: since }
    });

    return {
        total,
        converted,
        rate: (converted / total) * 100
    };
};

export default mongoose.models.DetectorFeedback ||
    mongoose.model('DetectorFeedback', detectorFeedbackSchema);
