// controllers/whatsappController.js

import { redisConnection as redis } from '../config/redisConnection.js';
import { getIo } from "../config/socket.js";
import Contact from "../models/Contact.js";
import Followup from "../models/Followup.js";
import Lead from '../models/Leads.js';
import Message from "../models/Message.js";
import { generateAmandaReply } from "../services/aiAmandaService.js";
import { resolveMediaUrl, sendTemplateMessage, sendTextMessage } from "../services/whatsappService.js";
import { normalizeE164BR, tailPattern } from "../utils/phone.js";

// ✅ AMANDA 2.0 - Response Tracking
import { checkFollowupResponse } from "../services/responseTrackingService.js";

export const whatsappController = {

    async sendTemplate(req, res) {
        try {
            const { phone, template, params = [], leadId } = req.body;
            if (!phone || !template) {
                return res.status(400).json({ success: false, error: "Campos obrigatórios: phone e template" });
            }
            const to = normalizeE164BR(phone);
            const result = await sendTemplateMessage({ to, template, params, lead: leadId });

            // (opcional) persistir template outbound p/ aparecer no chat
            const saved = await Message.create({
                from: process.env.CLINIC_PHONE_E164 || to, // número da clínica
                to,
                direction: "outbound",
                type: "template",
                content: `[TEMPLATE] ${template}`,
                templateName: template,
                status: "sent",
                timestamp: new Date(),
                lead: leadId || null,
            });

            const io = getIo();
            io.emit("message:new", {
                id: String(saved._id),
                from: saved.from,
                to: saved.to,
                direction: "outbound",
                type: "template",
                content: saved.content,
                status: saved.status,
                timestamp: saved.timestamp,
            });

            res.json({ success: true, result });
        } catch (err) {
            console.error("❌ Erro ao enviar template WhatsApp:", err);
            res.status(500).json({ success: false, error: err.message });
        }
    },

    async sendText(req, res) {
        try {
            const { phone, text, leadId } = req.body;
            if (!phone || !text) {
                return res.status(400).json({ success: false, error: "Campos obrigatórios: phone e text" });
            }

            const to = normalizeE164BR(phone); // cliente
            const clinicFrom = process.env.CLINIC_PHONE_E164 || to; // número da clínica (melhor setar no .env)

            const result = await sendTextMessage({ to, text, lead: leadId });

            // 🔹 PERSISTE OUTBOUND
            const saved = await Message.create({
                from: clinicFrom,
                to,
                direction: "outbound",
                type: "text",
                content: text,
                status: "sent",
                timestamp: new Date(),
                lead: leadId || null,
            });

            // 🔹 EMITE PARA A UI
            const io = getIo();
            io.emit("message:new", {
                id: String(saved._id),
                from: saved.from,
                to: saved.to,
                direction: "outbound",
                type: "text",
                content: saved.content,
                status: saved.status,
                timestamp: saved.timestamp,
            });

            res.json({ success: true, result });
        } catch (err) {
            console.error("❌ Erro ao enviar texto WhatsApp:", err);
            res.status(500).json({ success: false, error: err.message });
        }
    },

    async getWebhook(req, res) {
        try {
            const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
            const mode = req.query["hub.mode"];
            const token = req.query["hub.verify_token"];
            const challenge = req.query["hub.challenge"];

            if (mode && token && mode === "subscribe" && token === verifyToken) {
                return res.status(200).send(challenge);
            }
            return res.sendStatus(403);
        } catch (err) {
            console.error("❌ Erro na verificação do webhook:", err);
            res.sendStatus(500);
        }
    },

   async webhook(req, res) {
  console.log("🔔 [DEBUG] WEBHOOK POST RECEIVED", new Date().toISOString());
  
  try {
    const io = getIo();
    const change = req.body.entry?.[0]?.changes?.[0];
    const value = change?.value;

    // ✅ 1. RESPONDE IMEDIATAMENTE para evitar timeout
    res.sendStatus(200);

    // ✅ 2. Verifica se é mensagem válida (APÓS responder)
    if (!value?.messages || !Array.isArray(value.messages) || !value.messages[0]) {
      console.log("🔔 Webhook recebido, mas não é mensagem");
      return;
    }

    const msg = value.messages[0];
    const wamid = msg.id;
    const fromRaw = msg.from || "";

    console.log("📨 INBOUND RECEBIDO:", { 
      wamid, 
      from: fromRaw, 
      type: msg.type,
      timestamp: new Date().toISOString()
    });

    // ✅ 3. DEDUPLICAÇÃO MELHORADA (não bloqueia se Redis falhar)
    let isDuplicate = false;
    try {
      if (redis?.set) {
        const seenKey = `wa:seen:${wamid}`;
        const ok = await redis.set(seenKey, "1", "EX", 300, "NX");
        if (ok !== "OK") {
          console.log("⏭️ Mensagem duplicada, ignorando:", wamid);
          isDuplicate = true;
        }
      }
    } catch (e) {
      console.warn("⚠️ Redis indisponível, continuando sem dedup:", e.message);
    }

    if (isDuplicate) return;

    // ✅ 4. PROCESSAMENTO EM BACKGROUND (não bloqueia webhook)
    this.processInboundMessage(msg, value).catch(error => {
      console.error("❌ Erro no processamento background:", error);
    });

  } catch (err) {
    console.error("❌ Erro crítico no webhook:", err);
    // Já respondemos 200, então só logamos o erro
  }
},

// ✅ 5. NOVO MÉTODO: Processamento assíncrono
async processInboundMessage(msg, value) {
  try {
    const io = getIo();
    const wamid = msg.id;
    const fromRaw = msg.from || "";
    const toRaw = value?.metadata?.display_phone_number || process.env.CLINIC_PHONE_E164 || "";
    
    const from = normalizeE164BR(fromRaw);
    const to = normalizeE164BR(toRaw);
    const type = msg.type;
    const timestamp = new Date((parseInt(msg.timestamp, 10) || Date.now() / 1000) * 1000);

    console.log("🔄 Processando mensagem:", { from, type, wamid });

    // ✅ 6. EXTRAÇÃO DE CONTEÚDO (igual ao seu código atual)
    let content = "";
    let mediaUrl = null;
    let caption = null;
    let mediaId = null;

    if (type === "text") {
      content = msg.text?.body || "";
    } else {
      // ... (seu código atual de extração de mídia)
      try {
        if (type === "audio" && msg.audio?.id) {
          mediaId = msg.audio.id;
          caption = "[AUDIO]";
          const { url } = await resolveMediaUrl(mediaId);
          mediaUrl = url;
        } 
        // ... (outros tipos de mídia - mantenha seu código)
      } catch (e) {
        console.error("⚠️ Falha ao resolver mídia:", e.message);
      }
    }

    const contentToSave = type === "text" ? content : (caption || `[${type.toUpperCase()}]`);

    // ✅ 7. SALVAR MENSAGEM NO CRM
    let contact = await Contact.findOne({ phone: from });
    if (!contact) {
      contact = await Contact.create({ 
        phone: from, 
        name: msg.profile?.name || "Contato" 
      });
      console.log("✅ Novo contato criado:", contact._id);
    }

    let lead = await Lead.findOne({ 'contact.phone': from });
    if (!lead) {
      lead = await Lead.create({
        name: contact.name,
        contact: { phone: from },
        origin: "WhatsApp"
      });
      console.log("✅ Novo lead criado:", lead._id);
    }

    const savedMessage = await Message.create({
      wamid,
      from,
      to,
      direction: "inbound",
      type,
      content: contentToSave,
      mediaUrl,
      mediaId,
      caption,
      status: "received",
      needs_human_review: type !== "text",
      timestamp,
      contact: contact._id,
      lead: lead._id,
      raw: msg,
    });

    console.log("💾 Mensagem salva no CRM:", savedMessage._id);

    // ✅ 8. NOTIFICAR FRONTEND
    io.emit("message:new", {
      id: String(savedMessage._id),
      from,
      to,
      direction: "inbound",
      type,
      content: contentToSave,
      text: contentToSave,
      mediaUrl,
      mediaId,
      caption,
      status: "received",
      timestamp,
    });

    // ✅ 9. AMANDA 2.0 TRACKING (NÃO-BLOQUEANTE)
    if (type === 'text' && contentToSave?.trim()) {
      this.handleResponseTracking(lead._id, contentToSave)
        .catch(err => console.error("⚠️ Tracking não crítico falhou:", err));
    }

    // ✅ 10. RESPOSTA AUTOMÁTICA (NÃO-BLOQUEANTE)
    if (type === "text" && contentToSave?.trim()) {
      this.handleAutoReply(from, to, contentToSave, lead)
        .catch(err => console.error("⚠️ Auto-reply não crítico falhou:", err));
    }

    console.log("✅ Mensagem processada com sucesso:", wamid);

  } catch (error) {
    console.error("❌ Erro no processInboundMessage:", error);
    throw error;
  }
},

// ✅ 11. MÉTODO SEPARADO: Tracking de respostas
async handleResponseTracking(leadId, content) {
  try {
    const lastFollowup = await Followup.findOne({
      lead: leadId,
      status: 'sent',
      responded: false
    }).sort({ sentAt: -1 }).lean();

    if (lastFollowup) {
      const timeSince = Date.now() - new Date(lastFollowup.sentAt).getTime();
      const WINDOW_72H = 72 * 60 * 60 * 1000;

      if (timeSince < WINDOW_72H) {
        console.log(`✅ Lead respondeu a follow-up! Processando...`);
        await checkFollowupResponse(lastFollowup._id);
      }
    }
  } catch (error) {
    console.error('❌ Erro no tracking (não crítico):', error.message);
    // ⚠️ NÃO relança o erro - não deve quebrar o fluxo principal
  }
},

// ✅ 12. MÉTODO SEPARADO: Auto-reply
async handleAutoReply(from, to, content, lead) {
  try {
    // ... (seu código atual de auto-reply, mas separado)
    // Implemente a lógica de resposta automática aqui
  } catch (error) {
    console.error('❌ Erro no auto-reply (não crítico):', error);
    // ⚠️ NÃO relança o erro
  }
},

    async getChat(req, res) {
        try {
            const { phone } = req.params;
            if (!phone) return res.status(400).json({ error: "Número de telefone é obrigatório" });

            const pE164 = normalizeE164BR(phone);
            // match exato
            let msgs = await Message.find({
                $or: [{ from: pE164 }, { to: pE164 }],
            }).sort({ timestamp: 1 });

            // fallback por "rabo"
            if (msgs.length === 0) {
                const tail = tailPattern(phone, 8, 11);
                msgs = await Message.find({
                    $or: [{ from: { $regex: tail } }, { to: { $regex: tail } }],
                }).sort({ timestamp: 1 });
            }

            res.json({ success: true, data: msgs });
        } catch (err) {
            console.error("❌ Erro ao buscar chat:", err);
            res.status(500).json({ error: err.message });
        }
    },

    async listContacts(_req, res) {
        try {
            const contacts = await Contact.find().sort({ name: 1 });
            res.json(contacts);
        } catch (err) {
            console.error("❌ Erro ao listar contatos:", err);
            res.status(500).json({ error: err.message });
        }
    },

    async addContact(req, res) {
        try {
            const { name, phone, avatar } = req.body;
            if (!name || !phone) return res.status(400).json({ error: "Nome e telefone são obrigatórios" });

            const p = normalizeE164BR(phone);
            const existing = await Contact.findOne({ phone: p });
            if (existing) return res.status(400).json({ error: "Contato com esse telefone já existe" });

            const contact = await Contact.create({ name, phone: p, avatar });
            res.status(201).json(contact);
        } catch (err) {
            console.error("❌ Erro ao adicionar contato:", err);
            res.status(500).json({ error: err.message });
        }
    },

    async updateContact(req, res) {
        try {
            if (req.body?.phone) req.body.phone = normalizeE164BR(req.body.phone);
            const updated = await Contact.findByIdAndUpdate(req.params.id, req.body, { new: true });
            res.json(updated);
        } catch (err) {
            console.error("❌ Erro ao atualizar contato:", err);
            res.status(500).json({ error: err.message });
        }
    },

    async deleteContact(req, res) {
        try {
            await Contact.findByIdAndDelete(req.params.id);
            res.json({ success: true });
        } catch (err) {
            console.error("❌ Erro ao deletar contato:", err);
            res.status(500).json({ error: err.message });
        }
    },

};