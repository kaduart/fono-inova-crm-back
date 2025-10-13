// workers/followup.cron.js
import pkg from "bullmq"; // ✅ CommonJS compat
import dotenv from "dotenv";
import mongoose from "mongoose";
const { Queue } = pkg;

import { redisConnection } from "../config/redisConnection.js";
import Followup from "../models/Followup.js";

dotenv.config();
await mongoose.connect(process.env.MONGO_URI);
console.log("🕒 Follow-up Cron (BullMQ + Upstash) - modo interval");

const followupQueue = new Queue("followupQueue", { connection: redisConnection });

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

// roda a cada 60s
setInterval(checkAndQueueFollowups, 60 * 1000);
console.log("⏱️ Varredura de follow-ups a cada 60s iniciada");
