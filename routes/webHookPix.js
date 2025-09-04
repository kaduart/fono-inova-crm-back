import express from 'express';
import { getIo } from '../config/socket.js';

const router = express.Router();

router.post('/webhook', (req, res) => {
  const payload = req.body;

  // Responde rápido ao Sicoob
  res.status(200).send('OK');

  if (!payload?.pix || !Array.isArray(payload.pix)) {
    console.log('Webhook recebido mas sem Pix');
    return;
  }

  try {
    const io = getIo();

    payload.pix.forEach((pix) => {
      const formattedPix = {
        id: pix.txid,
        amount: parseFloat(pix.valor),
        date: new Date(pix.horario),
        appointmentId: pix.txid,
        payer: pix.pagador || 'Não informado',
      };

      console.log('💸 Pix recebido:', formattedPix);
      io.emit('pix-received', formattedPix); // Notifica front
    });

  } catch (err) {
    console.error('Erro ao processar webhook Pix:', err);
  }
});

export default router;
