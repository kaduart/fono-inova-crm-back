import express from 'express';
import qrcode from 'qrcode';
import whatsappWebService from '../services/whatsappWebService.js';

const router = express.Router();

// GET /api/whatsapp-web/status
router.get('/status', (req, res) => {
  const { isReady, hasQR } = whatsappWebService.getStatus();
  res.json({ isReady, hasQR });
});

// GET /api/whatsapp-web/qr  — pagina HTML para escanear o QR
router.get('/qr', async (req, res) => {
  const { isReady, hasQR, qrCode } = whatsappWebService.getStatus();

  if (isReady) {
    return res.send('<h2 style="font-family:sans-serif;color:green">✅ WhatsApp já está conectado!</h2>');
  }

  if (!hasQR) {
    return res.send('<h2 style="font-family:sans-serif">⏳ Aguardando QR Code... Atualize em alguns segundos.</h2><script>setTimeout(()=>location.reload(),3000)</script>');
  }

  const qrImage = await qrcode.toDataURL(qrCode);
  res.send(`
    <html>
    <head><title>WhatsApp QR</title></head>
    <body style="font-family:sans-serif;text-align:center;padding:40px">
      <h2>Escaneie o QR Code com o WhatsApp</h2>
      <img src="${qrImage}" style="width:300px;height:300px" />
      <p>Após escanear, esta página vai confirmar automaticamente.</p>
      <script>
        setInterval(async () => {
          const r = await fetch('/api/whatsapp-web/status');
          const data = await r.json();
          if (data.isReady) location.reload();
        }, 3000);
      </script>
    </body>
    </html>
  `);
});

// POST /api/whatsapp-web/send
router.post('/send', async (req, res) => {
  const { phone, message } = req.body;

  if (!phone || !message) {
    return res.status(400).json({ success: false, error: 'phone e message sao obrigatorios' });
  }

  try {
    const result = await whatsappWebService.sendMessage(phone, message);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
