// scripts/leads/send-test-followup.js
import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import chalk from "chalk";
import { followupQueue } from "../../config/bullConfig.js";
import Followup from "../../models/Followup.js";
import Lead from "../../models/Leads.js";

async function main() {
  console.log("🚀 Iniciando script de teste de follow-up...");

  await mongoose.connect(process.env.MONGO_URI);
  console.log("✅ Conectado ao MongoDB");

  const lead = await Lead.findOne({ name: "Teste Amanda Dev" })
    .populate("contact")
    .lean();

  if (!lead) {
    console.error("❌ Lead de teste não encontrado");
    process.exit(1);
  }

  console.log("👤 Lead de teste:", {
    id: String(lead._id),
    name: lead.name,
    phone: lead.contact?.phone,
  });

  const followup = await Followup.create({
    lead: lead._id,
    stage: "follow_up",
    scheduledAt: new Date(),            // agora
    status: "scheduled",
    aiOptimized: true,
    origin: lead.origin || "teste-script",
    playbook: null,
    message: "",                        // deixa vazio pra Amanda gerar
  });

  console.log("📄 Followup criado:", {
    id: String(followup._id),
    status: followup.status,
    scheduledAt: followup.scheduledAt,
  });

  const job = await followupQueue.add(
    "followup",
    { followupId: String(followup._id) },
    {
      jobId: `fu-${followup._id}`,
      priority: 5,
    }
  );

  const state = await job.getState();

  console.log("📬 Followup enfileirado com sucesso!", {
    jobId: job.id,
    name: job.name,
    state,
  });

  process.exit(0);
}

main();
