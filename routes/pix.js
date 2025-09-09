import { Router } from 'express';
import { getPixReceived } from '../controllers/sicoobController.js';
import { createPixCharge } from '../services/sicoobService.js';
import { handlePixWebhook } from '../services/webhookService.js';

const router = Router();

// Criar cobrança Pix
router.post('/create/:appointmentId', async (req, res) => {
    try {
        const result = await createPixCharge(req.params.appointmentId);
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message || err });
    }
});

// Webhook para notificações do Sicoob
router.post('/webhook', handlePixWebhook);

// Consultar Pix recebidos
router.get('/received', getPixReceived);

export default router;