// crons/followup.cron.js
import chalk from "chalk";
import mongoose from "mongoose";
import { followupQueue } from "../config/bullConfig.js";
import { redisConnection } from "../config/redisConnection.js";
import Followup from "../models/Followup.js";
import Message from "../models/Message.js";
import { buildContextPack } from "../services/intelligence/ContextPack.js";

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

    // busca followups agendados até agora (limit pra evitar varredura gigante)
    const pend = await Followup.find({
      status: "scheduled",
      scheduledAt: { $lte: now }
    })
      .populate({
        path: "lead",
        select: "conversionScore name status convertedToPatient origin contact stopAutomation"
      })
      .sort({ scheduledAt: 1 })
      .limit(200)
      .lean();

    if (!pend || !pend.length) {
      console.log(chalk.gray("⏳ Nenhum follow-up pendente..."));
      return;
    }

    // filtra followups que NÃO devem ser enviados
    const checks = await Promise.all(
      pend.map(async (f) => {
        const lead = f.lead;

        // se populate falhou ou lead nulo -> joga fora (evita crash)
        if (!lead?._id) return null;

        // regras de exclusão
        if (lead.status === "agendado") return null;
        if (lead.status === "converted") return null;
        if (lead.convertedToPatient) return null;

        // ⚠️ se stopAutomation é do LEAD, usa lead.stopAutomation
        // se for do contact embedado, usa lead.contact?.stopAutomation
        if (lead.stopAutomation === true) return null;
        if (lead.contact?.stopAutomation === true) return null;

        const recentInbound = await Message.findOne({
          lead: lead._id,
          direction: "inbound",
          timestamp: { $gte: new Date(Date.now() - 1000 * 60 * 60 * 12) }
        }).lean();

        if (recentInbound) return null;

        return f;
      })
    );

    const filtered = checks.filter(Boolean);


    if (!filtered.length) {
      console.log(chalk.gray("⏳ Após filtro, nenhum follow-up válido."));
      return;
    }

    // ordena por score (quentes primeiro)
    const sorted = filtered.sort((a, b) => {
      const scoreA = a.lead?.conversionScore || 0;
      const scoreB = b.lead?.conversionScore || 0;
      return scoreB - scoreA;
    });

    // log simples
    const hot = sorted.filter(f => (f.lead?.conversionScore || 0) >= 80).length;
    const warm = sorted.filter(f => {
      const s = f.lead?.conversionScore || 0;
      return s >= 50 && s < 80;
    }).length;
    const cold = sorted.length - hot - warm;

    console.log(chalk.cyan(`📬 ${sorted.length} follow-ups prontos para envio (após filtro)`));
    console.log(chalk.red(`   🔥 ${hot} quentes`));
    console.log(chalk.yellow(`   🟡 ${warm} mornos`));
    console.log(chalk.blue(`   🧊 ${cold} frios`));

    // enfileira
    for (const f of sorted) {
      const lead = f.lead;
      if (!lead?._id) continue;

      // ============================================================
      // 🔹 Verificação de contexto antes de enfileirar follow-up
      // Evita mensagens frias ou genéricas em leads sem tom definido
      // ============================================================
      const contextPack = await buildContextPack(lead._id);

      if (!contextPack?.toneMode || !contextPack?.mode) {
        console.log(`[FOLLOWUP-CRON] Lead ${lead._id} ignorado (sem contexto válido)`);
        continue;
      }

      await followupQueue.add(
        "followup",
        { followupId: String(f._id) },
        {
          jobId: `fu-${f._id}`, // idempotência
          priority: getPriority(f.lead?.conversionScore || 0),
        }
      );
    }

    console.log(chalk.green(`✅ ${sorted.length} follow-ups processados!`));

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