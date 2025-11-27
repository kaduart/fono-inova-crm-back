import dotenv from "dotenv";
dotenv.config();

import { Worker } from "bullmq";
import chalk from "chalk";
import mongoose from "mongoose";

import Contact from "../models/Contact.js";
import Followup from "../models/Followup.js";
import Lead from "../models/Leads.js";
import Message from "../models/Message.js";

import { followupQueue } from "../config/bullConfig.js";
import { getIo } from "../config/socket.js";
import { normalizeE164BR } from "../utils/phone.js";

// Amanda 2.0
import { analyzeLeadMessage } from "../services/intelligence/leadIntelligence.js";
import {
  calculateOptimalFollowupTime,
  generateContextualFollowup
} from "../services/intelligence/smartFollowup.js";

// Amanda 1.0 (fallback)
import { generateFollowupMessage } from "../services/aiAmandaService.js";
import { sendTemplateMessage, sendTextMessage } from "../services/whatsappService.js";

await mongoose.connect(process.env.MONGO_URI);

const FOLLOWUP_WINDOW_DAYS = 3;      // só pra log se quiser usar depois
const MAX_ATTEMPTS_PER_LEAD = 3;     // ⛔ máximo de contatos por lead
const MIN_INTERVAL_HOURS = 24;

const worker = new Worker(
  followupQueue.name,
  async (job) => {
    const { followupId } = job.data;

    console.log(chalk.cyan(`[WORKER] Processando follow-up ${followupId}`));

    const followup = await Followup.findById(followupId).populate("lead");
    if (!followup) {
      console.warn(chalk.yellow(`⚠️ Follow-up ${followupId} não encontrado`));
      return;
    }

    if (["sent", "failed"].includes(followup.status)) {
      console.warn(
        chalk.yellow(
          `⚠️ Follow-up ${followupId} já terminal (${followup.status}), ignorando`
        )
      );
      return;
    }

    const lead = followup.lead;
    if (!lead?.contact?.phone) {
      await Followup.findByIdAndUpdate(followupId, {
        status: "failed",
        error: "Lead sem telefone",
        failedAt: new Date()
      });
      return;
    }

    try {
      // =====================================================
      // 🧠 1. AMANDA 2.0 - ANÁLISE DO CONTEXTO
      // =====================================================
      const recentMessages = await Message.find({ lead: lead._id })
        .sort({ timestamp: -1 })
        .limit(10)
        .lean();

      const lastInbound = recentMessages.find(
        (m) => m.direction === "inbound"
      );

      // Tentativas anteriores (todas que já foram enviadas pra esse lead)
      const previousAttempts = await Followup.countDocuments({
        lead: lead._id,
        status: "sent"
      });

      console.log(
        chalk.blue(
          `[AMANDA] Lead: ${lead.name} | Tentativas já feitas: ${previousAttempts}`
        )
      );

      // se já bateu o limite, NÃO manda mais nada
      if (previousAttempts >= MAX_ATTEMPTS_PER_LEAD) {
        console.log(
          chalk.yellow(
            `[AMANDA] Lead ${lead._id} já recebeu ${previousAttempts} follow-ups. Não enviar mais.`
          )
        );

        await Followup.findByIdAndUpdate(followupId, {
          status: "failed",
          error: `Limite de ${MAX_ATTEMPTS_PER_LEAD} follow-ups atingido`,
          failedAt: new Date()
        });

        return;
      }

      let analysis = null;
      let shouldStopByIntent = false;
      if (lastInbound?.content) {
        try {
          analysis = await analyzeLeadMessage({
            text: lastInbound.content,
            lead,
            history: recentMessages.map((m) => m.content || "")
          });

          console.log(
            chalk.green(
              `[AMANDA] Análise: Score=${analysis.score} | Segment=${analysis.segment.emoji} | Intent=${analysis.intent.primary}`
            )
          );

          await Lead.findByIdAndUpdate(lead._id, {
            conversionScore: analysis.score,
            "qualificationData.extractedInfo": analysis.extracted,
            "qualificationData.intent": analysis.intent.primary,
            "qualificationData.sentiment": analysis.intent.sentiment,
            lastScoreUpdate: new Date(),
            $push: {
              scoreHistory: {
                score: analysis.score,
                reason: `${analysis.intent.primary} - ${analysis.intent.sentiment}`,
                date: new Date()
              }
            }
          });

          // 👉 Se a Amanda 2.0 entendeu que a pessoa NÃO TEM INTERESSE, parar tudo
          const intentPrimary = (analysis.intent?.primary || "").toLowerCase();
          const uninterestedIntents = [
            "sem_interesse",
            "sem interesse",
            "nao_interessado",
            "não_interessado",
            "not_interested"
          ];

          if (uninterestedIntents.includes(intentPrimary)) {
            shouldStopByIntent = true;

            await Lead.findByIdAndUpdate(lead._id, {
              status: "sem_interesse"
            });

            console.log(
              chalk.yellow(
                `[AMANDA] Lead ${lead._id} sinalizou desinteresse (${intentPrimary}). Não enviar mais follow-ups.`
              )
            );
          }

        } catch (aiError) {
          console.warn(
            chalk.yellow("⚠️ Erro na análise Amanda 2.0:"),
            aiError.message
          );
        }
      }

      // Se a pessoa já sinalizou desinteresse, não envia nada e não agenda próximo
      if (shouldStopByIntent) {
        await Followup.findByIdAndUpdate(followupId, {
          status: "failed",
          error: "Lead sinalizou desinteresse (Amanda 2.0)",
          failedAt: new Date()
        });

        return;
      }

      // =====================================================
      // ✍️ 2. DEFINIR TEXTO FINAL A ENVIAR
      // =====================================================
      let messageToSend = followup.message || "";

      if (followup.aiOptimized || !messageToSend.trim()) {
        try {
          if (analysis) {
            // Amanda 2.0
            messageToSend = generateContextualFollowup({
              lead,
              analysis,
              attempt: previousAttempts + 1
            });

            console.log(
              chalk.green(
                `[AMANDA 2.0] Mensagem gerada: "${messageToSend.substring(
                  0,
                  80
                )}..."`
              )
            );
          } else {
            // Fallback Amanda 1.0
            const optimized = await generateFollowupMessage(lead);
            if (optimized?.trim()) {
              messageToSend = optimized;
              console.log(chalk.yellow(`[AMANDA 1.0] Fallback usado`));
            }
          }
        } catch (e) {
          console.warn(
            chalk.yellow("⚠️ Erro na geração de mensagem:"),
            e.message
          );

          const rawName = (lead?.name || "").trim();
          let firstName = rawName.split(/\s+/)[0] || "";

          const blacklist = ["contato", "cliente", "lead", "paciente"];
          if (firstName && blacklist.includes(firstName.toLowerCase())) {
            firstName = "";
          }

          if (firstName) {
            messageToSend = `Oi ${firstName}! 💚 Passando para saber se posso te ajudar. Estamos à disposição!`;
          } else {
            messageToSend = `Oi! 💚 Passando para saber se posso te ajudar. Estamos à disposição!`;
          }
        }

      }

      // Personalização
      let sentText = messageToSend;
      if (!followup.playbook) {
        const rawName = (lead?.name || "").trim();
        let firstName = rawName.split(/\s+/)[0] || "";

        // protege contra nomes genéricos que possam ter escapado
        const blacklist = ["contato", "cliente", "lead", "paciente"];
        if (firstName && blacklist.includes(firstName.toLowerCase())) {
          firstName = "";
        }

        // Só adiciona prefixo de origem se NÃO for Amanda 2.0
        if (!analysis && lead.origin && !followup.aiOptimized) {
          const o = (lead.origin || "").toLowerCase();
          if (o.includes("google")) {
            sentText = `Vimos seu contato pelo Google 😉 ${sentText}`;
          } else if (o.includes("meta") || o.includes("instagram")) {
            sentText = `Olá! Vi sua mensagem pelo Instagram 💬 ${sentText}`;
          } else if (o.includes("indic")) {
            sentText = `Ficamos felizes pela indicação 🙌 ${sentText}`;
          }
        }

        if (firstName) {
          // substitui todos {{nome}}, {{ nome }}, etc (case-insensitive)
          sentText = sentText.replace(/{{\s*nome\s*}}/gi, firstName);
        } else {
          // sem nome → remove placeholder e vírgula/ponto grudado
          // Ex: "Oi {{nome}}! 💚" -> "Oi 💚"
          sentText = sentText.replace(/[ ,]*{{\s*nome\s*}}[!,.]?/gi, "");
        }
      }


      // =====================================================
      // 🚀 3. ENVIO + REGISTRO NO CHAT (Message + socket)
      // =====================================================
      const to = normalizeE164BR(lead.contact.phone);
      const contact = await Contact.findOne({ phone: to }).lean();
      const patientId = lead.convertedToPatient || null;
      const io = getIo();

      let waMessageId = null;
      let saved = null;

      if (followup.playbook) {
        // ---------- TEMPLATE (PLAYBOOK) ----------
        const result = await sendTemplateMessage({
          to,
          template: followup.playbook,
          params: [{ type: "text", text: sentText }],
          lead: lead._id
        });

        waMessageId =
          result?.waMessageId || result?.messages?.[0]?.id || null;

        // Salva manualmente em Message (igual ao controller sendTemplate)
        saved = await Message.create({
          from: process.env.CLINIC_PHONE_E164 || to,
          to,
          direction: "outbound",
          type: "template",
          content: `[TEMPLATE][Amanda] ${followup.playbook}`,
          templateName: followup.playbook,
          status: "sent",
          timestamp: new Date(),
          lead: lead._id,
          contact: contact?._id || null,
          waMessageId,
          metadata: {
            sentBy: "amanda_followup"
          }
        });

        // Emite socket para aparecer no chat
        io.emit("message:new", {
          id: String(saved._id),
          from: saved.from,
          to: saved.to,
          direction: saved.direction,
          type: saved.type,
          content: saved.content,
          text: sentText,
          status: saved.status,
          timestamp: saved.timestamp,
          leadId: String(saved.lead || lead._id),
          contactId: String(saved.contact || contact?._id || ""),
          metadata: saved.metadata
        });
      } else {
        // ---------- TEXTO NORMAL ----------
        const result = await sendTextMessage({
          to,
          text: sentText,
          lead: lead._id,
          contactId: contact?._id || null,
          patientId,
          sentBy: "amanda_followup",
          userId: null
        });

        waMessageId = result?.messages?.[0]?.id || null;

        // Espera salvar no Mongo
        await new Promise((resolve) => setTimeout(resolve, 200));

        if (waMessageId) {
          saved = await Message.findOne({ waMessageId }).lean();
        }
        if (!saved) {
          saved = await Message.findOne({
            to,
            direction: "outbound",
            type: "text"
          })
            .sort({ timestamp: -1 })
            .lean();
        }

        if (saved) {
          io.emit("message:new", {
            id: String(saved._id),
            from: saved.from,
            to: saved.to,
            direction: saved.direction,
            type: saved.type,
            content: saved.content,
            text: saved.content,
            status: saved.status,
            timestamp: saved.timestamp,
            leadId: String(saved.lead || lead._id),
            contactId: String(saved.contact || contact?._id || ""),
            metadata: saved.metadata || { sentBy: "amanda_followup" }
          });
        } else {
          console.warn(
            chalk.yellow(
              "⚠️ Mensagem de follow-up enviada, mas não encontrei registro em Message para emitir socket."
            )
          );
        }
      }

      // =====================================================
      // ✅ 4. MARCAR FOLLOW-UP COMO ENVIADO
      // =====================================================
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
          amandaVersion: analysis ? "2.0" : "1.0",
          score: analysis?.score || lead.conversionScore || 0
        }
      });

      // =====================================================
      // 🔁 5. AGENDAR PRÓXIMO FOLLOW-UP (DRIP)
      // =====================================================
      const currentAttempt = previousAttempts + 1; // esta mensagem que acabamos de enviar

      if (currentAttempt < MAX_ATTEMPTS_PER_LEAD) {
        const nextAttemptNumber = currentAttempt + 1;
        const score = analysis?.score || lead.conversionScore || 50;

        let nextTime = calculateOptimalFollowupTime({
          lead,
          score,
          lastInteraction: new Date(),
          attempt: nextAttemptNumber
        });

        const MIN_INTERVAL_MS = MIN_INTERVAL_HOURS * 60 * 60 * 1000;
        const minAllowed = new Date(Date.now() + MIN_INTERVAL_MS);
        if (nextTime < minAllowed) {
          nextTime = minAllowed;
        }

        await Followup.create({
          lead: lead._id,
          stage: "follow_up",
          scheduledAt: nextTime,
          status: "scheduled",
          aiOptimized: true,
          origin: lead.origin,
          playbook: null,
          note: `Auto-gerado pela Amanda 2.0 (tentativa ${nextAttemptNumber}/${MAX_ATTEMPTS_PER_LEAD})`
        });

        console.log(
          chalk.green(
            `[AMANDA] Próximo follow-up agendado para ${nextTime.toLocaleString(
              "pt-BR"
            )} (tentativa ${nextAttemptNumber}/${MAX_ATTEMPTS_PER_LEAD})`
          )
        );
      } else {
        console.log(
          chalk.yellow(
            `[AMANDA] Limite de tentativas atingido (${MAX_ATTEMPTS_PER_LEAD}) para lead ${lead._id} - não agendar mais`
          )
        );
      }


      console.log(chalk.green(`✅ Follow-up ${followupId} enviado com sucesso!`));
    } catch (err) {
      await handleFollowupError(followupId, err);
    }
  },
  {
    connection: followupQueue.opts.connection,
    concurrency: 5
  }
);

// =====================================================
// ⚠️ 6. TRATAMENTO DE ERROS / RETENTATIVAS
// =====================================================
async function handleFollowupError(followupId, error) {
  console.error(
    chalk.red(`❌ Erro ao processar follow-up ${followupId}:`),
    error.message
  );

  try {
    const followup = await Followup.findById(followupId);
    if (!followup) return;

    const retryCount = (followup.retryCount || 0) + 1;
    const maxRetries = 3;

    if (retryCount < maxRetries) {
      const delayMs = Math.pow(2, retryCount) * 60 * 1000; // 2, 4, 8 min
      const nextAttempt = new Date(Date.now() + delayMs);

      await Followup.findByIdAndUpdate(followupId, {
        status: "scheduled",
        scheduledAt: nextAttempt,
        retryCount,
        lastErrorAt: new Date(),
        error: error.message?.substring(0, 500)
      });

      console.log(
        chalk.yellow(
          `⚠️ Follow-up ${followupId} reagendado para ${nextAttempt.toLocaleString(
            "pt-BR"
          )} (tentativa ${retryCount}/${maxRetries})`
        )
      );
    } else {
      await Followup.findByIdAndUpdate(followupId, {
        status: "failed",
        failedAt: new Date(),
        retryCount,
        error: error.message?.substring(0, 500)
      });

      console.error(
        chalk.red(
          `💥 Follow-up ${followupId} falhou definitivamente após ${maxRetries} tentativas`
        )
      );
    }
  } catch (updateError) {
    console.error(
      chalk.red("❌ Erro ao atualizar follow-up falhado:"),
      updateError
    );
  }
}

// Eventos do worker
worker.on("completed", (job) => {
  console.log(chalk.green(`✅ Job ${job.id} concluído`));
});

worker.on("failed", (job, err) => {
  console.error(chalk.red(`❌ Job ${job?.id} falhou:`), err.message);
});

worker.on("error", (err) => {
  console.error(chalk.red("💥 Worker error:"), err);
});

console.log(chalk.cyan("👷 Follow-up Worker iniciado com Amanda 2.0!"));

export default worker;
