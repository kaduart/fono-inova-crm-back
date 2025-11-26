// scripts/leads/dispatch-test-followup.js
import 'dotenv/config';
import mongoose from "mongoose";
import { followupQueue } from "../../config/bullConfig.js";
import Followup from "../../models/Followup.js";

async function main() {
    try {
        console.log("🚀 Iniciando script de dispatch de followup...");

        if (!process.env.MONGO_URI) {
            console.error("❌ MONGO_URI não definido no .env");
            process.exit(1);
        }

        await mongoose.connect(process.env.MONGO_URI);
        console.log("✅ Conectado ao MongoDB");

        const followupId = "6926f64857a6e8296c671f28"; // do script anterior
        console.log("🔎 Buscando followup:", followupId);

        const f = await Followup.findById(followupId);
        if (!f) {
            console.error("❌ Followup não encontrado no banco!");
            process.exit(1);
        }

        console.log("📄 Followup encontrado:", {
            id: f._id.toString(),
            status: f.status,
            scheduledAt: f.scheduledAt,
            lead: f.lead?.toString?.() || f.lead
        });

        await followupQueue.add(
            "followup",
            { followupId },
            {
                jobId: `fu-${followupId}`,
                priority: 5,
            }
        );

        console.log("📬 Followup enfileirado com sucesso!");
        process.exit(0);
    } catch (err) {
        console.error("💥 Erro no script:", err);
        process.exit(1);
    }
}

main();
