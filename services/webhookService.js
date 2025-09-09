import { getIo } from '../config/socket.js';

export const handlePixWebhook = async (req, res) => {
    try {
        const payload = req.body;
        console.log('🔔 Notificação recebida:', JSON.stringify(payload, null, 2));

        // Resposta imediata para Sicoob
        res.status(200).json({ mensagem: "Notificação recebida com sucesso" });

        // Verificar se é uma notificação de PIX
        if (payload.pix && Array.isArray(payload.pix)) {
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
        console.error('Erro ao processar webhook:', error);
        res.status(200).json({ mensagem: "Notificação recebida" });
    }
};