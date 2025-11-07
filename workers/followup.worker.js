// workers/followup.worker.js
import { Worker } from "bullmq";
import chalk from "chalk";
import mongoose from "mongoose";
import Followup from "../models/Followup.js";
import Lead from "../models/Leads.js";
import Message from "../models/Message.js";
import { redisConnection } from "../config/redisConnection.js";

// ✅ IMPORTS DA AMANDA 2.0
import { analyzeLeadMessage } from "../services/intelligence/leadIntelligence.js";
import {
  calculateOptimalFollowupTime,
  generateContextualFollowup
} from "../services/intelligence/smartFollowup.js";

// Fallback (se Amanda 2.0 falhar)
import { generateFollowupMessage } from "../services/aiAmandaService.js";
import { sendTemplateMessage, sendTextMessage } from "../services/whatsappService.js";

await mongoose.connect(process.env.MONGO_URI);

const worker = new Worker(
  "followupQueue",
  async (job) => {
    const { followupId } = job.data;

    console.log(chalk.cyan(`[WORKER] Processando follow-up ${followupId}`));

    const followup = await Followup.findById(followupId).populate("lead");
    if (!followup) {
      console.warn(chalk.yellow(`⚠️ Follow-up ${followupId} não encontrado`));
      return;
    }

    // Não reprocessar terminais
    if (["sent", "failed"].includes(followup.status)) {
      console.warn(chalk.yellow(`⚠️ Follow-up ${followupId} já terminal (${followup.status})`));
      return;
    }

    const lead = followup.lead;
    if (!lead?.contact?.phone) {
      await Followup.findByIdAndUpdate(followupId, {
        status: "failed",
        error: "Lead sem telefone",
        failedAt: new Date(),
      });
      return;
    }

    try {
      // =====================================================
      // 🧠 AMANDA 2.0 - INTELIGÊNCIA INTEGRADA
      // =====================================================

      // 1️⃣ Buscar histórico de mensagens
      const recentMessages = await Message.find({
        lead: lead._id
      })
        .sort({ timestamp: -1 })
        .limit(10)
        .lean();

      const lastInbound = recentMessages.find(m => m.direction === 'inbound');

      // 2️⃣ Contar tentativas anteriores
      const previousAttempts = await Followup.countDocuments({
        lead: lead._id,
        status: 'sent',
        createdAt: { $lt: followup.createdAt }
      });

      console.log(chalk.blue(`[AMANDA] Lead: ${lead.name} | Tentativa: ${previousAttempts + 1}`));

      // 3️⃣ Análise inteligente (se tiver mensagem do lead)
      let analysis = null;
      if (lastInbound?.content) {
        try {
          analysis = await analyzeLeadMessage({
            text: lastInbound.content,
            lead,
            history: recentMessages.map(m => m.content || '')
          });

          console.log(chalk.green(`[AMANDA] Análise: Score=${analysis.score} | Segment=${analysis.segment.emoji} | Intent=${analysis.intent.primary}`));

          // 4️⃣ Atualizar score no Lead
          await Lead.findByIdAndUpdate(lead._id, {
            conversionScore: analysis.score,
            'qualificationData.extractedInfo': analysis.extracted,
            'qualificationData.intent': analysis.intent.primary,
            'qualificationData.sentiment': analysis.intent.sentiment,
            lastScoreUpdate: new Date(),
            $push: {
              scoreHistory: {
                score: analysis.score,
                reason: `${analysis.intent.primary} - ${analysis.intent.sentiment}`,
                date: new Date()
              }
            }
          });

        } catch (aiError) {
          console.warn(chalk.yellow('⚠️ Erro na análise Amanda 2.0:', aiError.message));
        }
      }

      // 5️⃣ Gerar mensagem contextualizada
      let messageToSend = followup.message || "";

      if (followup.aiOptimized || !messageToSend.trim()) {
        try {
          // 🎯 USAR AMANDA 2.0
          if (analysis) {
            messageToSend = generateContextualFollowup({
              lead,
              analysis,
              attempt: previousAttempts + 1
            });
            console.log(chalk.green(`[AMANDA 2.0] Mensagem gerada: "${messageToSend.substring(0, 50)}..."`));
          } else {
            // Fallback para Amanda 1.0
            const optimized = await generateFollowupMessage(lead);
            if (optimized?.trim()) {
              messageToSend = optimized;
              console.log(chalk.yellow(`[AMANDA 1.0] Fallback usado`));
            }
          }
        } catch (e) {
          console.warn(chalk.yellow("⚠️ Erro na geração de mensagem:", e.message));
          // Fallback genérico
          const firstName = (lead?.name || "").split(" ")[0] || "tudo bem";
          messageToSend = `Oi ${firstName}! 💚 Passando para saber se posso te ajudar. Estamos à disposição!`;
        }
      }

      // 6️⃣ Personalização adicional (origem)
      let sentText = messageToSend;
      if (!followup.playbook) {
        const firstName = (lead?.name || "").trim().split(/\s+/)[0] || "tudo bem";

        // Só adiciona prefixo de origem se NÃO for Amanda 2.0
        if (!analysis && lead.origin && !followup.aiOptimized) {
          const o = (lead.origin || "").toLowerCase();
          if (o.includes("google")) sentText = `Vimos seu contato pelo Google 😉 ${sentText}`;
          else if (o.includes("meta") || o.includes("instagram")) sentText = `Olá! Vi sua mensagem pelo Instagram 💬 ${sentText}`;
          else if (o.includes("indic")) sentText = `Ficamos felizes pela indicação 🙌 ${sentText}`;
        }

        sentText = sentText.replace("{{nome}}", firstName);
      }

      // 7️⃣ Enviar mensagem
      if (followup.playbook) {
        await sendTemplateMessage({
          to: lead.contact.phone,
          template: followup.playbook,
          params: [{ type: "text", text: sentText }],
          lead: lead._id,
        });
      } else {
        await sendTextMessage({
          to: lead.contact.phone,
          text: sentText,
          lead: lead._id,
        });
      }

      // 8️⃣ Atualizar follow-up como enviado
      await Followup.findByIdAndUpdate(followupId, {
        status: "sent",
        sentAt: new Date(),
        finalMessage: sentText,
        aiOptimized: !!followup.aiOptimized || !!analysis,
        origin: followup.origin || lead.origin || null,
        processingContext: {
          optimized: sentText !== (followup.message || ""),
          sentAtHour: new Date().getHours(),
          weekday: new Date().getDay(),
          amandaVersion: analysis ? '2.0' : '1.0',
          score: analysis?.score || lead.conversionScore || 0
        },
      });

      // 9️⃣ Agendar próximo follow-up SE necessário
      if (previousAttempts + 1 < 3) { // Máximo 3 tentativas
        const score = analysis?.score || lead.conversionScore || 50;

        const nextTime = calculateOptimalFollowupTime({
          lead,
          score,
          lastInteraction: new Date(),
          attempt: previousAttempts + 2
        });

        await Followup.create({
          lead: lead._id,
          stage: 'follow_up',
          scheduledAt: nextTime,
          status: 'scheduled',
          aiOptimized: true,
          origin: lead.origin,
          playbook: null,
          note: `Auto-gerado pela Amanda 2.0 (tentativa ${previousAttempts + 2}/3)`
        });

        console.log(chalk.green(`[AMANDA] Próximo follow-up agendado para ${nextTime.toLocaleString('pt-BR')}`));
      } else {
        console.log(chalk.yellow(`[AMANDA] Limite de tentativas atingido (3) - não agendar mais`));
      }

      console.log(chalk.green(`✅ Follow-up ${followupId} enviado com sucesso!`));

    } catch (err) {
      await handleFollowupError(followupId, err);
    }
  },
  {
    connection: redisConnection,
    concurrency: 5 // Processa até 5 follow-ups em paralelo
  }
);

/**
 * Trata erros com retry inteligente
 */
async function handleFollowupError(followupId, error) {
  console.error(chalk.red(`❌ Erro ao processar follow-up ${followupId}:`), error.message);

  try {
    const followup = await Followup.findById(followupId);
    if (!followup) return;

    const retryCount = (followup.retryCount || 0) + 1;
    const maxRetries = 3;

    if (retryCount < maxRetries) {
      // Reagendar com backoff exponencial
      const delayMs = Math.pow(2, retryCount) * 60 * 1000; // 2min, 4min, 8min
      const nextAttempt = new Date(Date.now() + delayMs);

      await Followup.findByIdAndUpdate(followupId, {
        status: 'scheduled',
        scheduledAt: nextAttempt,
        retryCount,
        lastErrorAt: new Date(),
        error: error.message?.substring(0, 500)
      });

      console.log(chalk.yellow(`⚠️ Follow-up ${followupId} reagendado para ${nextAttempt.toLocaleString('pt-BR')} (tentativa ${retryCount}/${maxRetries})`));
    } else {
      // Falha definitiva
      await Followup.findByIdAndUpdate(followupId, {
        status: 'failed',
        failedAt: new Date(),
        retryCount,
        error: error.message?.substring(0, 500)
      });

      console.error(chalk.red(`💥 Follow-up ${followupId} falhou definitivamente após ${maxRetries} tentativas`));
    }
  } catch (updateError) {
    console.error(chalk.red('❌ Erro ao atualizar follow-up falhado:'), updateError);
  }
}

// Eventos do worker
worker.on('completed', (job) => {
  console.log(chalk.green(`✅ Job ${job.id} concluído`));
});

worker.on('failed', (job, err) => {
  console.error(chalk.red(`❌ Job ${job?.id} falhou:`), err.message);
});

worker.on('error', (err) => {
  console.error(chalk.red('💥 Worker error:'), err);
});

console.log(chalk.cyan('👷 Follow-up Worker iniciado com Amanda 2.0!'));

export default worker;