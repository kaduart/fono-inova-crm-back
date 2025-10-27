import { Worker } from "bullmq";
import chalk from "chalk";
import dotenv from "dotenv";
import mongoose from "mongoose";
import Followup from "../models/Followup.js";
import { generateFollowupMessage } from "../services/aiAmandaService.js";
import { sendTemplateMessage, sendTextMessage } from "../services/whatsappService.js";

dotenv.config();
await mongoose.connect(process.env.MONGO_URI);

// 🔗 Conexão BullMQ
const connection = {
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT || 6379),
  password: process.env.REDIS_PASSWORD,
};

console.log(chalk.cyan("🚀 Worker Follow-up com Amanda AI inicializado"));
console.log(chalk.gray(`⏰ Ambiente: ${process.env.NODE_ENV}`));

const worker = new Worker(
  "followupQueue",
  async (job) => {
    const { followupId } = job.data;
    const followup = await Followup.findById(followupId).populate("lead");
    if (!followup) return console.warn(`⚠️ Follow-up ${followupId} não encontrado`);

    const lead = followup.lead;
    if (!lead?.contact?.phone) {
      console.warn(`⚠️ Lead ${lead?._id} sem telefone`);
      await Followup.findByIdAndUpdate(followupId, {
        status: "failed",
        error: "Lead sem telefone"
      });
      return;
    }

    console.log(`🧠 Processando follow-up: ${followup._id} → ${lead.name}`);

    try {
      let messageToSend = followup.message;

      // 🎯 SE FOR FOLLOW-UP IA, OTIMIZA A MENSAGEM
      if (followup.aiOptimized || !followup.message?.trim()) {
        try {
          const optimizedMessage = await generateFollowupMessage(lead);
          messageToSend = optimizedMessage;
          console.log(chalk.blue(`🤖 Amanda otimizou mensagem para ${lead.name}`));
        } catch (aiError) {
          console.warn("⚠️ Erro na otimização da Amanda, usando mensagem original:", aiError.message);
        }
      }

      let result;

      if (followup.playbook) {
        result = await sendTemplateMessage({
          to: lead.contact.phone,
          template: followup.playbook,
          params: [{ type: "text", text: messageToSend }],
          lead: lead._id,
        });
      } else {
        // 🎯 PERSONALIZAÇÃO INTELIGENTE BASEADA NA ORIGEM
        let finalMessage = messageToSend;

        if (lead.name) {
          finalMessage = finalMessage.replace("{{nome}}", lead.name.split(" ")[0]);
        }

        if (lead.origin && !followup.aiOptimized) {
          const origin = (lead.origin || "").toLowerCase();
          if (origin.includes("google")) finalMessage = `Vimos seu contato pelo Google 😉 ${finalMessage}`;
          else if (origin.includes("meta") || origin.includes("instagram"))
            finalMessage = `Olá! Vi sua mensagem pelo Instagram 💬 ${finalMessage}`;
          else if (origin.includes("indic"))
            finalMessage = `Ficamos felizes pela indicação 🙌 ${finalMessage}`;
        }

        result = await sendTextMessage({
          to: lead.contact.phone,
          text: finalMessage,
          lead: lead._id,
        });
      }

      // ✅ ATUALIZA COM DADOS DE INTELIGÊNCIA
      await Followup.findByIdAndUpdate(followupId, {
        status: "sent",
        sentAt: new Date(),
        response: result,
        finalMessage: messageToSend,
        aiOptimized: followup.aiOptimized || false,
        processingContext: {
          optimized: messageToSend !== followup.message,
          sentAtHour: new Date().getHours(),
          weekday: new Date().getDay()
        }
      });

      console.log(chalk.green(`✅ Follow-up enviado → ${lead.contact.phone}`));

      // 🎯 AGENDA VERIFICAÇÃO DE RESPOSTA AUTOMÁTICA
      setTimeout(() => checkForLeadResponse(followupId), 10 * 60 * 1000); // 10 minutos

    } catch (err) {
      await handleFollowupError(followupId, err, lead);
    }
  },
  { connection }
);

/**
 * 🎯 Verifica se o lead respondeu ao follow-up
 */
async function checkForLeadResponse(followupId) {
  try {
    const followup = await Followup.findById(followupId).populate('lead');
    if (!followup || followup.responded) return;

    // Aqui você pode integrar com seu sistema de verificação de respostas
    // Por exemplo, verificar se houve nova mensagem do lead no WhatsApp
    console.log(`🔍 Verificando resposta do lead para follow-up ${followupId}`);

    // Simulação - em produção, integrar com webhook de respostas
    const hasResponse = false; // Substituir por lógica real

    if (hasResponse) {
      await Followup.findByIdAndUpdate(followupId, {
        responded: true,
        respondedAt: new Date(),
        status: 'responded'
      });
    }
  } catch (error) {
    console.warn("⚠️ Erro ao verificar resposta:", error.message);
  }
}

/**
 * 🚨 Tratamento de erros inteligente
 */
async function handleFollowupError(followupId, error, lead) {
  console.error(chalk.red("💥 Erro ao enviar follow-up:"), error.message);

  const followup = await Followup.findById(followupId);
  const retryCount = (followup.retryCount || 0) + 1;

  if (retryCount <= 3) {
    const delayMinutes = [15, 60, 180][retryCount - 1]; // Retry strategy
    const nextAttempt = new Date(Date.now() + delayMinutes * 60 * 1000);

    await Followup.findByIdAndUpdate(followupId, {
      status: "scheduled",
      scheduledAt: nextAttempt,
      retryCount,
      error: `Tentativa ${retryCount} falhou: ${error.message}`,
      lastErrorAt: new Date()
    });

    console.log(
      chalk.yellow(
        `🔁 Reagendado (${retryCount}/3) para ${nextAttempt.toLocaleString("pt-BR")}`
      )
    );
  } else {
    await Followup.findByIdAndUpdate(followupId, {
      status: "failed",
      retryCount,
      error: `Falhou após 3 tentativas: ${error.message}`,
      failedAt: new Date()
    });
    console.log(chalk.red(`❌ Follow-up ${followupId} marcado como failed.`));
  }
}

// Eventos do Worker
worker.on("completed", (job) => console.log(chalk.green(`🎯 Job ${job.id} concluído`)));
worker.on("failed", (job, err) => console.error(chalk.red(`💥 Job ${job?.id} falhou:`), err?.message));
worker.on("error", (err) => console.error(chalk.red("❌ Erro crítico no Worker:"), err?.message));