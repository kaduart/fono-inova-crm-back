import express from 'express';
import { getStatus, sendMessage, clearSession } from '../services/whatsappWebJsService.js';

const router = express.Router();

/**
 * GET /api/whatsapp-web/status
 * Retorna status da conexão e QR code (se necessário)
 */
router.get('/status', async (req, res) => {
  // Impede 304: desabilita comparação de ETag e proíbe cache
  delete req.headers['if-none-match'];
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  const status = await getStatus();
  res.json(status);
});

/**
 * POST /api/whatsapp-web/send
 * Envia mensagem via WhatsApp Web
 * Body: { phone: "556292013573", message: "texto" }
 */
router.post('/send', async (req, res) => {
  try {
    let { phone, message } = req.body;

    if (!phone || !message) {
      return res.status(400).json({
        success: false,
        error: 'Campos obrigatórios: phone e message'
      });
    }

    // Normaliza quebras de linha: converte \\n (escapado) para quebra real
    const originalMessage = message;
    message = message
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r');

    console.log('[WhatsAppWeb Route] Mensagem normalizada:', JSON.stringify(message));
    console.log('[WhatsAppWeb Route] Contém \\n?', message.includes('\n'));

    const result = await sendMessage(phone, message);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[WhatsAppWeb Route] Erro:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/whatsapp-web/reconnect
 * Limpa sessão e força novo QR code
 */
router.post('/reconnect', async (req, res) => {
  try {
    const result = await clearSession();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
