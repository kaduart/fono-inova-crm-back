// models/LearningInsight.js
import mongoose from "mongoose";

const learningInsightSchema = new mongoose.Schema(
    {
        type: {
            type: String,
            enum: ["conversation_patterns", "successful_responses", "common_objections"],
            required: true,
        },

        data: {
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

