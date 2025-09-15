import { getIo } from '../config/socket.js';
import { getReceivedPixes } from '../services/sicoobService.js';

/* export const createPix = async (req, res) => {
  try {
    const { appointmentId } = req.params;
    const result = await createPixCharge(appointmentId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || err });
  }
}; */

export const getReceived = async (req, res) => {
  try {
    const data = await getReceivedPixes(req.query);
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || err });
  }
};

export const handlePixWebhook = (req, res) => {
  try {
    const payload = req.body;
    console.log('🔔 Notificação PIX recebida:', JSON.stringify(payload, null, 2));

    res.status(200).json({ mensagem: "Notificação recebida com sucesso" });

    if (payload?.pix && Array.isArray(payload.pix)) {
      const io = getIo();
      payload.pix.forEach(pix => {
        const formattedPix = {
          id: pix.txid,
          amount: parseFloat(pix.valor),
          date: new Date(pix.horario || Date.now()),
          payer: pix.pagador || 'Não informado',
          status: 'recebido'
        };
        console.log('💸 Pix processado:', formattedPix);
        io.emit('pix-received', formattedPix);
      });
    }
  } catch (error) {
    console.error('❌ Erro ao processar webhook:', error);
    res.status(500).json({ mensagem: "Erro ao processar notificação" });
  }
};