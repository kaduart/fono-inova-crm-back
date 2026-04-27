// routes/testInbound.js
// 🧪 Endpoint simples para simular mensagem WhatsApp inbound em desenvolvimento
// NÃO usa filas, workers, event store — salva direto e emite socket.

import { Router } from 'express';
import { emitSocketEvent } from '../config/socket.js';
import Contacts from '../models/Contacts.js';
import Message from '../models/Message.js';
import { normalizeE164BR } from '../utils/phone.js';

const router = Router();

/**
 * POST /api/test/inbound
 * Body: { phone: "5511999999999", text: "Oi", name?: "Teste" }
 */
router.post('/inbound', async (req, res) => {
  try {
    const { phone, text, name = `WhatsApp ${phone.slice(-4)}` } = req.body;
    if (!phone || !text) {
      return res.status(400).json({ error: 'phone e text são obrigatórios' });
    }

    const from = normalizeE164BR(phone);
    const to = normalizeE164BR(process.env.CLINIC_PHONE_E164 || '5562993377726');

    // 1. Upsert contato
    let contact = await Contacts.findOne({ phone: from });
    if (!contact) {
      contact = await Contacts.create({ phone: from, name });
    }

    // 2. Atualiza contato
    await Contacts.findByIdAndUpdate(contact._id, {
      lastMessageAt: new Date(),
      lastMessagePreview: text.slice(0, 120),
    });

    // 3. Salva mensagem
    const saved = await Message.create({
      waMessageId: `test-${Date.now()}`,
      from,
      to,
      direction: 'inbound',
      type: 'text',
      content: text,
      status: 'received',
      timestamp: new Date(),
      contact: contact._id,
    });

    const payload = {
      id: saved._id.toString(),
      from,
      to,
      type: 'text',
      content: text,
      text,
      timestamp: new Date().toISOString(),
      direction: 'inbound',
      contactId: contact._id.toString(),
      contactName: contact.name,
    };

    // 4. Emite socket direto
    await emitSocketEvent('message:new', payload);
    await emitSocketEvent('chat:inbox:update', {
      leadId: contact._id.toString(),
      contactName: contact.name,
      phone: from,
      lastMessage: text.slice(0, 120),
      lastMessageAt: new Date().toISOString(),
      lastDirection: 'inbound',
      unreadCount: 1,
    });

    res.json({ success: true, messageId: saved._id.toString(), contactId: contact._id.toString() });
  } catch (err) {
    console.error('[TestInbound] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
