import { Router } from 'express';
import {
  checkPixStatus,
  generatePixCharge,
  pixWebhook,
  configureSicoobWebhook,
  getPixReceived
} from '../controllers/pixController.js';

const router = Router();

// Gerar cobrança Pix
router.post('/generate', generatePixCharge);

// Configurar webhook no Sicoob
router.put('/webhook/configure', configureSicoobWebhook);

// Webhook para notificações do Sicoob
router.post('/webhook', pixWebhook);

// Consultar status de uma cobrança
router.get('/status/:txid', checkPixStatus);

// Consultar PIX recebidos
router.get('/received', getPixReceived);

export default router;