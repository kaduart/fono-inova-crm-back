// workers/followup.worker.js
import { Worker } from "bullmq";
import chalk from "chalk";
import mongoose from "mongoose";
import Followup from "../models/Followup.js";
import { generateFollowupMessage } from "../services/aiAmandaService.js";
import { sendTemplateMessage, sendTextMessage } from "../services/whatsappService.js";
import { redisConnection } from "../config/redisConnection.js";

await mongoose.connect(process.env.MONGO_URI);

const worker = new Worker(
  "followupQueue",
  async (job) => {
    const { followupId } = job.data;

    const followup = await Followup.findById(followupId).populate("lead");
    if (!followup) {
      console.warn(`⚠️ Follow-up ${followupId} não encontrado`);
      return;
    }

    // não reprocessar terminais
    if (["sent", "failed"].includes(followup.status)) {
      console.warn(`⚠️ Follow-up ${followupId} já terminal (${followup.status})`);
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
      let messageToSend = followup.message || "";
      if (followup.aiOptimized || !messageToSend.trim()) {
        try {
          const optimized = await generateFollowupMessage(lead);
          if (optimized?.trim()) messageToSend = optimized;
        } catch (e) {
          console.warn("⚠️ Erro IA, usando mensagem original:", e.message);
        }
      }

      let sentText = messageToSend;
      if (!followup.playbook) {
        const firstName = (lead?.name || "").trim().split(/\s+/)[0] || "tudo bem";
        if (lead.origin && !followup.aiOptimized) {
          const o = (lead.origin || "").toLowerCase();
          if (o.includes("google")) sentText = `Vimos seu contato pelo Google 😉 ${sentText}`;
          else if (o.includes("meta") || o.includes("instagram")) sentText = `Olá! Vi sua mensagem pelo Instagram 💬 ${sentText}`;
          else if (o.includes("indic")) sentText = `Ficamos felizes pela indicação 🙌 ${sentText}`;
        }
        sentText = sentText.replace("{{nome}}", firstName);
      }

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

      await Followup.findByIdAndUpdate(followupId, {
        status: "sent",
        sentAt: new Date(),
        finalMessage: sentText,
        aiOptimized: !!followup.aiOptimized,
        origin: followup.origin || lead.origin || null,
        processingContext: {
          optimized: sentText !== (followup.message || ""),
          sentAtHour: new Date().getHours(),
          weekday: new Date().getDay(),
        },
      });

      // opcional: agendar checagem de resposta
      // setTimeout(() => checkForLeadResponse(followupId), 10 * 60 * 1000);
    } catch (err) {
      await handleFollowupError(followupId, err);
    }
  },
  { connection: redisConnection }
);

// ... (keep your handleFollowupError conforme já fez)
export default worker;
