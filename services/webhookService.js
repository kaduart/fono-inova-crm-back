// webhookService.js - função atualizada
export const handlePixWebhook = async (req, res) => {
    try {
        const payload = req.body;
        console.log('🔔 Notificação recebida:', payload);

        // Resposta imediata para Sicoob
        res.status(200).send('OK');

        // Verificar se é uma notificação de PIX
        if (payload.txid && payload.valor) {
            const formattedPix = {
                id: payload.txid,
                amount: parseFloat(payload.valor),
                date: new Date(payload.horario || Date.now()),
                payer: payload.pagador || 'Não informado',
                status: payload.status || 'recebido'
            };

            console.log('💸 Pix processado:', formattedPix);

            // Emitir via Socket.io
            const io = getIo();
            io.emit('pix-received', formattedPix);

            // Aqui você pode atualizar seu banco de dados
            // await updateAppointmentPaymentStatus(formattedPix);
        }
    } catch (error) {
        console.error('Erro ao processar webhook:', error);
    }
};