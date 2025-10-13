import dotenv from "dotenv";
import mongoose from "mongoose";
import { Queue } from "bullmq";
import Followup from "../models/Followup.js";

dotenv.config();
mongoose.connect(process.env.MONGO_URI);

// ✅ Configuração BullMQ com tolerância a falhas do Redis
const queue = new Queue("followupQueue", {
    connection: {
        host: process.env.REDIS_HOST || "localhost",
        port: process.env.REDIS_PORT || 6379,
        maxRetriesPerRequest: null,   // 👈 Desativa retry infinito
        enableReadyCheck: false,      // 👈 Evita erro de handshake Upstash/Render
    },
});

console.log("🕒 Follow-up cron iniciado...");

const checkAndQueueFollowups = async () => {
    try {
        const now = new Date();
        const followups = await Followup.find({
            status: "scheduled",
            scheduledAt: { $lte: now },
        });

        if (followups.length === 0) {
            console.log("⏳ Nenhum follow-up pendente...");
            return;
        }

        console.log(`📬 ${followups.length} follow-ups prontos para envio.`);

        for (const f of followups) {
            await queue.add("followup", { followupId: f._id });
            f.status = "processing";
            f.processingAt = new Date();
            await f.save();

            console.log(`➡️ Enfileirado: ${f._id} (${f.message.slice(0, 40)}...)`);
        }
    } catch (err) {
        console.error("❌ Erro ao verificar follow-ups:", err.message);
    }
};

// Executa a cada 60 segundos
setInterval(checkAndQueueFollowups, 60 * 1000);
