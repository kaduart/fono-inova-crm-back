import express from 'express';
import { whatsappController } from '../controllers/whatsappController.js';

const router = express.Router();

// 📤 Envio de mensagens
router.post('/send-template', whatsappController.sendTemplate);
router.post('/send-text', whatsappController.sendText);
router.delete('/messages/:id', whatsappController.deletarMsgChat);
// 📩 Webhook
router.post('/webhook', whatsappController.webhook);
router.get('/webhook', whatsappController.getWebhook);

// 💬 Histórico de chat
router.get('/chat/:phone', whatsappController.getChat);

// 👥 CRUD de contatos
router.get('/contacts', whatsappController.listContacts);
router.post('/contacts', whatsappController.addContact);
router.put('/contacts/:id', whatsappController.updateContact);
router.delete('/contacts/:id', whatsappController.deleteContact);
router.post('/send-manual', whatsappController.sendManualMessage);
router.post('/amanda-resume/:leadId', whatsappController.amandaResume);
router.get('/contacts/search', whatsappController.contactsSearch);
export default router;
