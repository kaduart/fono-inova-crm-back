// models/LearningInsight.js (CRIAR)

import mongoose from 'mongoose';

const learningInsightSchema = new mongoose.Schema({
    type: {
        type: String,
        enum: ['conversation_patterns', 'successful_responses', 'common_objections'],
        required: true
    },

    // Padrões descobertos
    data: {
        bestOpeningLines: [{
            text: String,
            leadOrigin: String,
            avgConversionTime: Number, // horas até conversão
            conversionRate: Number, // % que converteram
            usageCount: Number
        }],

        effectivePriceResponses: [{
            scenario: String, // "first_contact" | "returning" | "cold_lead"
            response: String,
            conversionRate: Number
        }],

        successfulClosingQuestions: [{
            question: String,
            context: String, // stage do lead
            ledToScheduling: Number // %
        }],

        commonObjections: [{
            objection: String,
            bestResponse: String,
            overcomingRate: Number // %
        }]
    },

    // Metadados
    leadsAnalyzed: Number,
    conversationsAnalyzed: Number,
    dateRange: {
        from: Date,
        to: Date
    },

    generatedAt: { type: Date, default: Date.now },
    appliedInProduction: { type: Boolean, default: false }
}, { timestamps: true });

export default mongoose.model('LearningInsight', learningInsightSchema);