import Message from '../models/Message.js';
import { handleWebhookEvent, sendTemplateMessage, sendTextMessage } from '../services/whatsappService.js';

export const whatsappController = {
    async sendTemplate(req, res) {
        try {
            const { phone, template, params, leadId } = req.body;
            const result = await sendTemplateMessage({ to: phone, template, params, lead: leadId });
            res.json({ success: true, result });
        } catch (err) {
            console.error('Erro ao enviar template:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    },

    async sendText(req, res) {
        try {
            const { phone, text, leadId } = req.body;
            const result = await sendTextMessage({ to: phone, text, lead: leadId });
            res.json({ success: true, result });
        } catch (err) {
            console.error('Erro ao enviar texto:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    },

    async webhook(req, res) {
        try {
            await handleWebhookEvent(req.body);
            res.sendStatus(200);
        } catch (err) {
            console.error('Erro webhook WhatsApp:', err);
            res.status(500).json({ error: err.message });
        }
    },

    async getChat(req, res) {
        try {
            const { phone } = req.params;
            const msgs = await Message.find({ $or: [{ to: phone }, { from: phone }] }).sort({ timestamp: 1 });
            res.json(msgs);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }
};
