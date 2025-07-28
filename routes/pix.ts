import { Router } from 'express';
import {
    checkPixStatus,
    generatePixCharge,
    pixWebhook
} from '../controllers/pixController';

const router = Router();

// Gerar cobrança Pix
router.post('/pix/generate', generatePixCharge);

// Webhook para notificações do Sicoob
router.post('/pix/webhook/sicoob', pixWebhook);

// Consultar status de uma cobrança
router.get('/pix/status/:txid', checkPixStatus);

export default router;