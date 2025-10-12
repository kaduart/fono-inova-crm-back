import express from 'express';
import { whatsappController } from '../controllers/whatsappController.js';

const router = express.Router();

router.post('/send-template', whatsappController.sendTemplate);
router.post('/send-text', whatsappController.sendText);
router.post('/webhook', whatsappController.webhook);
router.get('/chat/:phone', whatsappController.getChat);

export default router;
