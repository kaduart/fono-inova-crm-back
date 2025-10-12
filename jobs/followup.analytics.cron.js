// src/jobs/followup.analytics.cron.js
import mongoose from "mongoose";
import cron from "node-cron";
import Followup from "../models/Followup.js";
import FollowupAnalytics from "../models/FollowupAnalytics.js";
import dotenv from "dotenv";

dotenv.config();
mongoose.connect(process.env.MONGO_URI);

console.log("📊 Iniciando cron de análise semanal de Follow-ups...");

// 🕓 Executa todo domingo às 23:59
cron.schedule("59 23 * * 0", async () => {
  console.log("🔍 Rodando análise semanal de Follow-ups...");

  try {
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

    // Buscar follow-ups da última semana
    const followups = await Followup.find({
      sentAt: { $gte: oneWeekAgo },
    }).populate("lead");

    if (!followups.length) {
      console.log("⚠️ Nenhum follow-up encontrado na semana.");
      return;
    }

    // Totais por status
    const total = followups.length;
    const sent = followups.filter(f => f.status === "sent").length;
    const responded = followups.filter(f => f.status === "responded").length;
    const failed = followups.filter(f => f.status === "failed").length;

    // Taxa de resposta
    const conversionRate = total > 0 ? ((responded / total) * 100).toFixed(1) : 0;

    // Horário mais eficaz (hora com mais respostas)
    const hours = followups
      .filter(f => f.respondedAt)
      .map(f => new Date(f.respondedAt).getHours());
    const bestHour =
      hours.length > 0
        ? hours.sort(
            (a, b) =>
              hours.filter(h => h === b).length - hours.filter(h => h === a).length
          )[0]
        : null;

    // Canal mais engajador
    const channels = {};
    followups.forEach(f => {
      const origin = f.lead?.origin || "Desconhecido";
      channels[origin] = (channels[origin] || 0) + 1;
    });
    const bestChannel = Object.entries(channels).sort((a, b) => b[1] - a[1])[0][0];

    // Salvar resultado
    await FollowupAnalytics.create({
      date: new Date(),
      total,
      sent,
      responded,
      failed,
      conversionRate,
      bestHour,
      bestChannel,
    });

    console.log(`✅ Análise semanal registrada com sucesso (${conversionRate}% conversão)`);
  } catch (err) {
    console.error("❌ Erro na análise semanal:", err);
  }
});
