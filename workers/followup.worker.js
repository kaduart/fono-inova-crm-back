import { Worker } from "bullmq";
import chalk from "chalk";
import dotenv from "dotenv";
import mongoose from "mongoose";
import Followup from "../models/Followup.js";
import { sendTemplateMessage, sendTextMessage } from "../services/whatsappService.js";

dotenv.config();
await mongoose.connect(process.env.MONGO_URI);

// 🔗 Conexão BullMQ (mesma do cron)
const connection = {
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT || 6379),
  password: process.env.REDIS_PASSWORD,
};

console.log(chalk.cyan("🚀 Worker Follow-up inicializado (BullMQ + Local)"));
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
        let msg = followup.message || "";
        if (lead.name) msg = msg.replace("{{nome}}", lead.name.split(" ")[0]);

        if (lead.origin) {
          const origin = (lead.origin || "").toLowerCase();
          if (origin.includes("google")) msg = `Vimos seu contato pelo Google 😉 ${msg}`;
          else if (origin.includes("meta") || origin.includes("instagram"))
            msg = `Olá! Vi sua mensagem pelo Instagram 💬 ${msg}`;
          else if (origin.includes("indic"))
            msg = `Ficamos felizes pela indicação 🙌 ${msg}`;
        }

        result = await sendTextMessage({
          to: lead.contact.phone,
          text: msg,
          lead: lead._id,
        });
      }

      followup.status = "sent";
      followup.sentAt = new Date();
      followup.response = result;
      await followup.save();

      console.log(chalk.green(`✅ Follow-up enviado → ${lead.contact.phone}`));
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
            `🔁 Reagendado (${followup.retryCount}/3) para ${nextAttempt.toLocaleString("pt-BR")}`
          )
        );
      } else {
        followup.status = "failed";
        followup.error = `Falhou após 3 tentativas: ${err.message}`;
        await followup.save();
        console.log(chalk.red(`❌ Follow-up ${followup._id} marcado como failed.`));
      }
    }
  },
  { connection }
);

worker.on("completed", (job) => console.log(chalk.green(`🎯 Job ${job.id} concluído`)));
worker.on("failed", (job, err) => console.error(chalk.red(`💥 Job ${job?.id} falhou:`), err?.message));
worker.on("error", (err) => console.error(chalk.red("❌ Erro crítico no Worker:"), err?.message));
