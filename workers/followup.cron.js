// crons/followup.cron.js
import chalk from "chalk";
import mongoose from "mongoose";
import { followupQueue } from "../config/bullConfig.js";
import { redisConnection } from "../config/redisConnection.js";
import Followup from "../models/Followup.js";
import Message from "../models/Message.js";
import enrichLeadContext from "../services/leadContext.js";
import { processInactiveLeads } from "../services/inactiveLeadFollowupService.js";

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
    let skippedCount = { noLead: 0, agendado: 0, converted: 0, convertedToPatient: 0, stopAutomation: 0, recentInbound: 0 };
    
    const checks = await Promise.all(
      pend.map(async (f) => {
        const lead = f.lead;

        // se populate falhou ou lead nulo -> joga fora (evita crash)
        if (!lead?._id) {
          skippedCount.noLead++;
          console.log(chalk.yellow(`[FOLLOWUP-SKIP] ${f._id}: Lead não encontrado`));
          return null;
        }

        // regras de exclusão
        if (lead.status === "agendado") {
          skippedCount.agendado++;
          console.log(chalk.yellow(`[FOLLOWUP-SKIP] ${f._id}: Lead status='agendado'`));
          return null;
        }
        if (lead.status === "converted") {
          skippedCount.converted++;
          console.log(chalk.yellow(`[FOLLOWUP-SKIP] ${f._id}: Lead status='converted'`));
          return null;
        }
        if (lead.convertedToPatient) {
          skippedCount.convertedToPatient++;
          console.log(chalk.yellow(`[FOLLOWUP-SKIP] ${f._id}: Lead convertedToPatient=true`));
          return null;
        }

        // ⚠️ se stopAutomation é do LEAD, usa lead.stopAutomation
        // se for do contact embedado, usa lead.contact?.stopAutomation
        if (lead.stopAutomation === true) {
          skippedCount.stopAutomation++;
          console.log(chalk.yellow(`[FOLLOWUP-SKIP] ${f._id}: Lead stopAutomation=true`));
          return null;
        }
        if (lead.contact?.stopAutomation === true) {
          skippedCount.stopAutomation++;
          console.log(chalk.yellow(`[FOLLOWUP-SKIP] ${f._id}: Contact stopAutomation=true`));
          return null;
        }

        const recentInbound = await Message.findOne({
          lead: lead._id,
          direction: "inbound",
          timestamp: { $gte: new Date(Date.now() - 1000 * 60 * 60 * 12) }
        }).lean();

        if (recentInbound) {
          skippedCount.recentInbound++;
          const minsAgo = Math.round((Date.now() - new Date(recentInbound.timestamp).getTime()) / 60000);
          console.log(chalk.yellow(`[FOLLOWUP-SKIP] ${f._id}: Mensagem inbound recente (${minsAgo}min atrás)`));
          return null;
        }

        return f;
      })
    );

    const filtered = checks.filter(Boolean);

    if (!filtered.length) {
      console.log(chalk.gray(`⏳ Após filtro, nenhum follow-up válido. Skipped:`, skippedCount));
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
      // ============================================================
      const leadContext = await enrichLeadContext(lead._id).catch(() => null);

      if (!leadContext?.toneMode || !leadContext?.mode) {
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

// 🆕 VERIFICAÇÃO DE LEADS INATIVOS (48h/72h) - a cada 6 horas
async function runInactiveLeadCheck() {
  console.log(chalk.cyan('[INACTIVE-CHECK] Verificando leads inativos...'));
  try {
    const result = await processInactiveLeads();
    console.log(chalk.green(`[INACTIVE-CHECK] Concluído: ${result.created} follow-ups criados`));
  } catch (error) {
    console.error(chalk.red('[INACTIVE-CHECK] Erro:'), error.message);
  }
}

// Roda a cada 6 horas
setInterval(runInactiveLeadCheck, 6 * 60 * 60 * 1000);

// Execução inicial
dispatchPendingFollowups();
runInactiveLeadCheck(); // Roda também na inicialização

console.log(chalk.cyan('⏰ Follow-up Cron iniciado (scan a cada 3min + inactive check a cada 6h)'));