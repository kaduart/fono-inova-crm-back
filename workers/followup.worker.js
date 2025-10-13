import { Worker } from "bullmq";
import chalk from "chalk";
import dotenv from "dotenv";
import IORedis from "ioredis";
import mongoose from "mongoose";
import { redisConnection } from "../config/redisConnection.js";
import Followup from "../models/Followup.js";
import { sendTemplateMessage, sendTextMessage } from "../services/whatsappService.js";

// ======================================================
// 🔇 Intercepta ruído "127.0.0.1:6379" (seguro, sem loop)
// ======================================================
const originalEmit = IORedis.prototype.emit;
IORedis.prototype.emit = function (event, ...args) {
  if (event === "error" && args[0]?.message?.includes("127.0.0.1:6379")) return;
  return originalEmit.call(this, event, ...args);
};

// ======================================================
// 🚀 Inicialização e conexão base
// ======================================================
dotenv.config();
mongoose.connect(process.env.MONGO_URI);

console.log(chalk.cyan("🚀 Worker Follow-up inicializado (BullMQ + Upstash)"));
console.log(chalk.gray(`⏰ Ambiente: ${process.env.NODE_ENV}`));
console.log(chalk.gray(`🔗 Redis: ${process.env.REDIS_URL?.includes("upstash") ? "Upstash (TLS)" : "Local"}`));

// ======================================================
// 🧠 Worker BullMQ compatível com Upstash
// ======================================================
const worker = new Worker(
  "followupQueue",
  async (job) => {
    const { followupId } = job.data;
    const followup = await Followup.findById(followupId).populate("lead");

    if (!followup) {
      console.warn(`⚠️ Follow-up ${followupId} não encontrado`);
      return;
    }

    const lead = followup.lead;
    if (!lead?.contact?.phone) {
      console.warn(`⚠️ Lead ${lead?._id} sem telefone`);
      followup.status = "failed";
      followup.error = "Lead sem telefone";
      await followup.save();
      return;
    }

    console.log(`⏰ Enviando follow-up: ${followup._id} → ${lead.name}`);

    try {
      let result;

      if (followup.playbook) {
        result = await sendTemplateMessage({
          to: lead.contact.phone,
          template: followup.playbook,
          params: [{ type: "text", text: followup.message }],
          lead: lead._id,
        });
      } else {
        let personalizedMessage = followup.message;

        if (lead.name)
          personalizedMessage = personalizedMessage.replace(
            "{{nome}}",
            lead.name.split(" ")[0]
          );

        if (lead.origin) {
          const origin = lead.origin.toLowerCase();
          if (origin.includes("google"))
            personalizedMessage = `Vimos seu contato pelo Google 😉 ${personalizedMessage}`;
          else if (
            origin.includes("meta") ||
            origin.includes("facebook") ||
            origin.includes("instagram")
          )
            personalizedMessage = `Olá! Vi sua mensagem pelo Instagram 💬 ${personalizedMessage}`;
          else if (origin.includes("indic"))
            personalizedMessage = `Ficamos felizes pela indicação 🙌 ${personalizedMessage}`;
        }

        result = await sendTextMessage({
          to: lead.contact.phone,
          text: personalizedMessage,
          lead: lead._id,
        });
      }

      followup.status = "sent";
      followup.sentAt = new Date();
      followup.response = result;
      await followup.save();

      console.log(chalk.green(`✅ Follow-up enviado com sucesso → ${lead.contact.phone}`));
    } catch (err) {
      console.error(chalk.red("💥 Erro ao enviar follow-up:"), err.message);
      followup.retryCount = (followup.retryCount || 0) + 1;

      if (followup.retryCount <= 3) {
        const delayMinutes = [10, 60, 180][followup.retryCount - 1];
        const nextAttempt = new Date(Date.now() + delayMinutes * 60 * 1000);

        followup.status = "scheduled";
        followup.scheduledAt = nextAttempt;
        followup.error = `Tentativa ${followup.retryCount} falhou: ${err.message}`;
        await followup.save();

        console.log(
          chalk.yellow(
            `🔁 Reagendado automaticamente (${followup.retryCount}/3) para ${nextAttempt.toLocaleString("pt-BR")}`
          )
        );
      } else {
        followup.status = "failed";
        followup.error = `Falhou após 3 tentativas: ${err.message}`;
        await followup.save();
        console.log(chalk.red(`❌ Follow-up ${followup._id} marcado como "failed" após 3 tentativas.`));
      }
    }
  },
  { connection: redisConnection }
);

// ======================================================
// 🧩 Eventos do Worker (monitoramento Render/OCI)
// ======================================================
worker.on("completed", (job) =>
  console.log(chalk.green(`🎯 Job ${job.id} concluído com sucesso`))
);
worker.on("failed", (job, err) =>
  console.error(chalk.red(`💥 Job ${job.id} falhou:`), err.message)
);
worker.on("error", (err) => {
  if (!String(err).includes("127.0.0.1:6379"))
    console.error(chalk.red("❌ Erro crítico no Worker:"), err.message);
});
