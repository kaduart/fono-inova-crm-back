// crons/followup.cron.js
import mongoose from "mongoose";
import chalk from "chalk";
import { followupQueue } from "../config/bullConfig.js";
import { redisConnection } from "../config/redisConnection.js";
import Followup from "../models/Followup.js";

await mongoose.connect(process.env.MONGO_URI);

const LOCK_KEY = "cron:followups:scan-lock";
const LOCK_TTL_SECONDS = 60;

async function withLock(key, ttl, fn) {
  const ok = await redisConnection.set(key, "1", "EX", ttl, "NX");
  if (ok !== "OK") return;
  try {
    await fn();
  } finally {
    try {
      await redisConnection.del(key);
    } catch { }
  }
}

async function dispatchPendingFollowups() {
  await withLock(LOCK_KEY, LOCK_TTL_SECONDS, async () => {
    const now = new Date();

    // ✅ MELHORIA: Prioriza por score (leads quentes primeiro)
    const pend = await Followup.find({
      status: "scheduled",
      scheduledAt: { $lte: now }
    })
      .populate('lead', 'conversionScore name')
      .sort({ scheduledAt: 1 })
      .limit(200)
      .lean();

    if (!pend.length) {
      console.log(chalk.gray("⏳ Nenhum follow-up pendente..."));
      return;
    }

    // ✅ MELHORIA: Ordena por score (quentes primeiro)
    const sorted = pend.sort((a, b) => {
      const scoreA = a.lead?.conversionScore || 0;
      const scoreB = b.lead?.conversionScore || 0;
      return scoreB - scoreA; // Maior score primeiro
    });

    // ✅ MELHORIA: Estatísticas
    const hot = sorted.filter(f => (f.lead?.conversionScore || 0) >= 80).length;
    const warm = sorted.filter(f => {
      const score = f.lead?.conversionScore || 0;
      return score >= 50 && score < 80;
    }).length;
    const cold = sorted.length - hot - warm;

    console.log(chalk.cyan(`📬 ${pend.length} follow-ups prontos para envio:`));
    console.log(chalk.red(`   🔥 ${hot} quentes (≥80)`));
    console.log(chalk.yellow(`   🟡 ${warm} mornos (50-79)`));
    console.log(chalk.blue(`   🧊 ${cold} frios (<50)`));

    for (const f of sorted) {
      await followupQueue.add(
        "followup",
        { followupId: String(f._id) },
        {
          jobId: `fu-${f._id}`, // idempotência
          priority: getPriority(f.lead?.conversionScore || 0)
        }
      );
    }

    console.log(chalk.green(`✅ ${sorted.length} follow-ups enfileirados!`));
  });
}

/**
 * Calcula prioridade da fila (menor = mais prioritário)
 */
function getPriority(score) {
  if (score >= 80) return 1; // Alta prioridade
  if (score >= 50) return 5; // Média prioridade
  return 10; // Baixa prioridade
}

// ✅ MELHORIA: Intervalo reduzido para 3 minutos (mais responsivo)
setInterval(dispatchPendingFollowups, 3 * 60 * 1000);

// Execução inicial
dispatchPendingFollowups();

console.log(chalk.cyan('⏰ Follow-up Cron iniciado (scan a cada 3min)'));