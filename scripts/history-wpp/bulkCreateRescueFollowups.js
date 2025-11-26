// scripts/bulkCreateRescueFollowups.js
import "dotenv/config";
import mongoose from "mongoose";
import Lead from "../models/Leads.js";
import Followup from "../models/Followup.js";

// helpers simples
const normalizeDigits = (phone) => {
  if (!phone) return null;
  return String(phone).replace(/\D/g, "");
};

async function main() {
  const MONGO_URI = process.env.MONGO_URI;

  if (!MONGO_URI) {
    console.error("❌ MONGO_URI não definido no .env");
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  console.log("✅ MongoDB conectado");

  const now = new Date();

  // 1) Busca leads não convertidos, com telefone real
  const rawLeads = await Lead.find(
    {
      status: { $ne: "virou_paciente" },
      $or: [
        { convertedToPatient: { $exists: false } },
        { convertedToPatient: null }
      ],
      "contact.phone": {
        $exists: true,
        $ne: null,
        $not: /^hist_/
      },
      // se quiser excluir os puramente históricos:
      // origin: { $ne: "WhatsApp Histórico" }
    },
    {
      name: 1,
      contact: 1,
      status: 1,
      lastInteractionAt: 1,
      origin: 1
    }
  )
    .sort({ lastInteractionAt: -1 }) // mais recentes primeiro
    .lean();

  console.log(`📊 Leads não convertidos encontrados: ${rawLeads.length}`);

  // 2) Dedupe por telefone
  const byPhone = new Map();

  for (const lead of rawLeads) {
    const phone = normalizeDigits(lead.contact?.phone);
    if (!phone) continue;

    // se já temos esse telefone, mantemos o que tiver lastInteractionAt mais recente
    const existing = byPhone.get(phone);
    if (!existing) {
      byPhone.set(phone, lead);
    } else {
      const existingDate = existing.lastInteractionAt || new Date(0);
      const thisDate = lead.lastInteractionAt || new Date(0);
      if (thisDate > existingDate) {
        byPhone.set(phone, lead);
      }
    }
  }

  const dedupedLeads = Array.from(byPhone.values());
  console.log(`📚 Após dedupe por telefone: ${dedupedLeads.length} leads`);

  // Limite por rodada pra não explodir
  const LIMIT = Number(process.argv[2]) || 100;
  const candidates = dedupedLeads.slice(0, LIMIT);

  console.log(`🎯 Vamos tentar criar followup para até ${candidates.length} leads`);

  let created = 0;
  let skippedFuture = 0;

  for (const lead of candidates) {
    // 3) Checa se já existe followup futuro
    const hasFuture = await Followup.exists({
      lead: lead._id,
      scheduledAt: { $gte: now },
      status: { $in: ["scheduled", "processing"] }
    });

    if (hasFuture) {
      skippedFuture++;
      continue;
    }

    // 4) Define quando agendar -> exemplo: amanhã às 12h (UTC)
    const scheduledAt = new Date();
    scheduledAt.setDate(scheduledAt.getDate() + 1);
    scheduledAt.setUTCHours(12, 0, 0, 0);

    await Followup.create({
      lead: lead._id,
      message: "", // Amanda gera na hora pelo stage
      stage: "follow_up",
      scheduledAt,
      status: "scheduled",
      retryCount: 0,
      error: null,
      aiOptimized: true,
      responded: false,
      origin: "WhatsApp",
      note: "Resgate automático de lead não convertido"
    });

    created++;
  }

  console.log("✅ Finalizado.");
  console.log(`   Followups criados: ${created}`);
  console.log(`   Ignorados (já tinham followup futuro): ${skippedFuture}`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Erro no script:", err);
  process.exit(1);
});
