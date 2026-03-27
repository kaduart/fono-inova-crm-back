// workers/addJobTest.js
import dotenv from "dotenv";
dotenv.config();

import { Queue } from "bullmq";
import { bullMqConnection } from "../config/redisConnection.js";

console.log(`🔎 REDIS_URL em runtime: ${process.env.REDIS_URL || "N/D"}`);
console.log(`🔎 NODE_ENV: ${process.env.NODE_ENV || "development"}`);

const queue = new Queue("followupQueue", { connection: bullMqConnection });

(async () => {
  try {
    console.log("🚀 Teste de enfileiramento de follow-up iniciado...");

    // Cria job de teste
    const job = await queue.add("followup", {
      followupId: "66f1b23ea1c48bb5cecb9999", // substitua por um follow-up real existente
    });

    console.log(`📤 Job criado com ID: ${job.id}`);
  } catch (err) {
    console.error("❌ Erro ao criar job:", err.message);
  } finally {
    await queue.close();
    process.exit(0);
  }
})();
