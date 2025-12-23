// crons/followup.cron.js
import mongoose from "mongoose";
import chalk from "chalk";
import { followupQueue } from "../config/bullConfig.js";
import { redisConnection } from "../config/redisConnection.js";
import Followup from "../models/Followup.js";
import Message from "../models/Message.js";

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
    // filtra followups que NÃO devem ser enviados (PRECISA ser sequencial/await)
    const filtered = [];

    for (const f of pend) {
      // ✅ guard: lead pode vir null no populate
      if (!f?.lead?._id) continue;

      const lead = f.lead;
      const contact = lead.contact || {};

      // rejeita leads que já marcaram/foram convertidos
      if (lead.status === "agendado") continue;
      if (lead.status === "converted") continue;
      if (lead.convertedToPatient) continue;

      // rejeita contatos com flag para parar automações
      if (contact.stopAutomation === true) continue;

      const recentInbound = await Message.findOne({
        lead: f.lead._id,
        direction: "inbound",
        timestamp: { $gte: new Date(Date.now() - 1000 * 60 * 60 * 12) } // últimas 12h
      }).select({ _id: 1 }).lean();

      if (recentInbound) continue;

      filtered.push(f);
    }

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