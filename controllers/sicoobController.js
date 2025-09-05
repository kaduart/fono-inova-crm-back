import { getIo } from '../config/socket.js';
import { createPixCharge, getReceivedPixes } from '../services/sicoobService.js';

// Criar cobrança
export const createCharge = async (req, res) => {
  try {
    const { appointmentId } = req.params;
    const result = await createPixCharge(appointmentId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// Webhook do Sicoob
export const pixWebhook = (req, res) => {
  const payload = req.body;
  res.status(200).send('OK');

  if (!payload?.pix || !Array.isArray(payload.pix)) return;

  try {
    const io = getIo();
    payload.pix.forEach((pix) => {
      const formatted = {
        id: pix.txid,
        amount: parseFloat(pix.valor),
        date: new Date(pix.horario),
        payer: pix.pagador || 'Não informado'
      };
      console.log('💸 Pix recebido:', formatted);
      io.emit('pix-received', formatted);
    });
  } catch (err) {
    console.error('Erro ao processar webhook Pix:', err);
  }
};

// Consultar Pix recebidos
export const getPixReceived = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const result = await getReceivedPixes({ startDate, endDate });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
