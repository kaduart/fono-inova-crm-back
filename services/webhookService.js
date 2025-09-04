// webhookService.js
import { getIo } from "../config/socket.js";

export const handlePixWebhook = async (req, res) => {
    const payload = req.body;

    if (!payload?.pix || !Array.isArray(payload.pix)) {
        return res.status(200).send("Webhook recebido mas sem pix");
    }

    console.log("Webhook Pix recebido:", payload);

    // Responde rápido ao Sicoob
    res.status(200).send("OK");

    try {
        // ⚠️ Não usar 'const io = ...' se já houver outra declaração
        const ioInstance = getIo(); // apenas variável nova
        ioInstance.emit('pix-received', { id: 'TESTE', amount: 100, date: new Date(), payer: 'João' });

        for (const pix of payload.pix) {
            const formattedPix = {
                id: pix.txid,
                amount: parseFloat(pix.valor),
                date: new Date(pix.horario),
                appointmentId: pix.txid,
                payer: pix.pagador || "Não informado",
            };

            console.log("💸 Pix recebido:", formattedPix);

            ioInstance.emit("pix-received", formattedPix);
        }
    } catch (error) {
        console.error("Erro ao processar Pix:", error);
    }
};
