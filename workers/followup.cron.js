import { Queue } from "bullmq";
import dotenv from "dotenv";
import mongoose from "mongoose";
import Followup from "../models/Followup.js";
import { followupQueue } from "../config/bullConfig.js";

dotenv.config();
await mongoose.connect(process.env.MONGO_URI);



const checkAndQueueFollowups = async () => {
  try {
    const now = new Date();
    const followups = await Followup.find({
      status: "scheduled",
      scheduledAt: { $lte: now },
    }).lean(); // menor uso de memória

    if (!followups.length) {
      console.log("⏳ Nenhum follow-up pendente...");
      return;
    }

    console.log(`📬 ${followups.length} follow-ups prontos para envio.`);
    for (const f of followups) {
      await followupQueue.add("followup", { followupId: f._id.toString() });
      await Followup.updateOne(
        { _id: f._id },
        { $set: { status: "processing", processingAt: new Date() } }
      );
      console.log(`➡️ Enfileirado: ${f._id} (${(f.message || "").slice(0, 40)}...)`);
    }
  } catch (err) {
    console.error("❌ Erro ao verificar follow-ups:", err.message);
  }
};

// a cada 5 min
setInterval(checkAndQueueFollowups, 5 * 60 * 1000);
console.log("⏱️ Varredura de follow-ups a cada 5 minutos iniciada");

checkAndQueueFollowups(); // roda 1x na inicialização
