import { Queue } from "bullmq";
import dotenv from "dotenv";
import mongoose from "mongoose";
import Followup from "../models/Followup.js";
import { getRedis, startRedis } from "../services/redisClient.js";

dotenv.config();
await mongoose.connect(process.env.MONGO_URI);
await startRedis();

const connection = getRedis();
console.log(`🕒 Follow-up Cron (BullMQ + ${process.env.REDIS_URL ? "Upstash" : "Local"}) iniciado`);

const followupQueue = new Queue("followupQueue", { connection });

const checkAndQueueFollowups = async () => {
  try {
    const now = new Date();
    const followups = await Followup.find({
      status: "scheduled",
      scheduledAt: { $lte: now },
    });

    if (!followups.length) {
      console.log("⏳ Nenhum follow-up pendente...");
      return;
    }

    console.log(`📬 ${followups.length} follow-ups prontos para envio.`);
    for (const f of followups) {
      await followupQueue.add("followup", { followupId: f._id });
      f.status = "processing";
      f.processingAt = new Date();
      await f.save();
      console.log(`➡️ Enfileirado: ${f._id} (${(f.message || "").slice(0, 40)}...)`);
    }
  } catch (err) {
    console.error("❌ Erro ao verificar follow-ups:", err.message);
  }
};

// 🕐 Executa a cada 5 minutos em vez de 1 minuto
setInterval(checkAndQueueFollowups, 5 * 60 * 1000);
console.log("⏱️ Varredura de follow-ups a cada 5 minutos iniciada");

checkAndQueueFollowups(); // roda 1x na inicialização
