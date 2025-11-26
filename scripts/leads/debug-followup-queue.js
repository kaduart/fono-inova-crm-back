// scripts/leads/debug-followup-queue.js
import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import chalk from "chalk";
import { followupQueue } from "../../config/bullConfig.js";

async function main() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log(chalk.cyan("✅ Conectado ao MongoDB"));

    console.log("🔎 Verificando fila:", followupQueue.name);

    const counts = await followupQueue.getJobCounts();
    console.log("📊 Contagem de jobs:", counts);

    const jobs = await followupQueue.getJobs(
      ["waiting", "delayed", "active", "completed", "failed"],
      0,
      20
    );

    if (!jobs.length) {
      console.log("📭 Nenhum job encontrado na fila.");
    }

    for (const job of jobs) {
      const state = await job.getState();
      console.log("➡️ Job:", {
        id: job.id,
        name: job.name,
        state,
        data: job.data,
      });
    }
  } catch (err) {
    console.error("❌ Erro no debug da fila:", err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

main();
