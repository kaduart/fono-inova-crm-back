import dotenv from "dotenv";
import mongoose from "mongoose";
import LearningInsight from "../models/LearningInsight.js";

dotenv.config();

await mongoose.connect(process.env.MONGO_URI);
console.log("✅ Conectado ao MongoDB");

const insight = await LearningInsight.create({
    type: "successful_responses",
    data: {
        effectivePriceResponses: [
            {
                scenario: "first_contact",
                response: "Atendemos no particular com recibo pra reembolso 💚",
                conversionRate: 0.82,
            },
        ],
    },
    leadsAnalyzed: 200,
    conversationsAnalyzed: 480,
});

console.log("🧩 Criado Insight:", insight._id);
await mongoose.disconnect();
