// models/LearningInsight.js
import mongoose from "mongoose";

const learningInsightSchema = new mongoose.Schema(
    {
        type: {
            type: String,
            enum: ["conversation_patterns", "successful_responses", "common_objections", "continuous_learning_cycle", "detector_effectiveness"],
            required: true,
        },

        data: {
            // Campos legados (conversation_patterns)
            bestOpeningLines: [
                {
                    text: String,
                    leadOrigin: String,
                    avgConversionTime: Number,
                    conversionRate: Number,
                    usageCount: Number,
                },
            ],
            effectivePriceResponses: [
                {
                    scenario: String, // "first_contact" | "returning" | "cold_lead"
                    response: String,
                    conversionRate: Number,
                },
            ],
            successfulClosingQuestions: [
                {
                    question: String,
                    context: String, // stage do lead
                    ledToScheduling: Number, // %
                },
            ],
            commonObjections: [
                {
                    objection: String,
                    bestResponse: String,
                    overcomingRate: Number, // %
                },
            ],
            // ⛔ O que NÃO fazemos (Learned Negative Scope)
            negativeScope: [
                {
                    term: String, // ex: "raio-x", "cirurgia"
                    phrase: String, // ex: "não realizamos raio-x"
                    frequency: Number,
                    verified: { type: Boolean, default: false } // 🔒 Human in the loop
                }
            ],
        },

        leadsAnalyzed: Number,
        conversationsAnalyzed: Number,
        dateRange: { from: Date, to: Date },

        generatedAt: { type: Date, default: Date.now },
        appliedInProduction: { type: Boolean, default: false },
    },
    { timestamps: true }
);

// 🔹 facilita buscas recentes
learningInsightSchema.index({ type: 1, createdAt: -1 });

export default mongoose.models.LearningInsight ||
    mongoose.model("LearningInsight", learningInsightSchema);

