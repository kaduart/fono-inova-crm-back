import { getIo } from '../config/socket.js';
import { createPixCharge, getReceivedPixes } from '../services/pixService.js';

// Criar cobrança Pix
export const createCharge = async (req, res) => {
    try {
        const { appointmentId } = req.body;
        const pixData = await createPixCharge(appointmentId);
        res.json(pixData);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
};

// Webhook Pix (chamado pelo Sicoob)
export const pixWebhook = async (req, res) => {
    const payload = req.body;
    res.status(200).send('OK'); // responder rápido

    if (!payload?.pix || !Array.isArray(payload.pix)) return;

    const io = getIo();
    payload.pix.forEach(pix => {
        const formattedPix = {
            id: pix.txid,
            amount: parseFloat(pix.valor),
            date: new Date(pix.horario),
            payer: pix.pagador || 'Não informado',
            appointmentId: pix.txid
        };
        console.log('💸 Pix recebido:', formattedPix);
        io.emit('pix-received', formattedPix);
    });
};

// Consultar Pix recebidos
export const getReceived = async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const data = await getReceivedPixes({ startDate, endDate });
        res.json(data);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
};
