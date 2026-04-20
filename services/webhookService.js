import mongoose from "mongoose";
import { getIo } from "../config/socket.js";
import Package from "../models/Package.js";
import Payment from "../models/Payment.js";
import { distributePayments } from "../services/distributePayments.js";
import moment from "moment-timezone";

/**
 * 🔔 Webhook principal para notificações PIX do Sicoob
 * - Responde imediatamente (200 OK)
 * - Processa cada transação em background
 * - Cria pagamento principal e distribui valor entre sessões do pacote
 */
export const handlePixWebhook = async (req, res) => {
    try {
        const payload = req.body;
        console.log("🔔 Notificação PIX recebida:", JSON.stringify(payload, null, 2));

        // ✅ 1. Resposta imediata para o Sicoob
        res.status(200).json({ mensagem: "Notificação recebida com sucesso" });

        // 🔹 2. Processa pagamentos em background
        if (payload.pix && Array.isArray(payload.pix)) {
            const io = getIo();

            for (const pix of payload.pix) {
                const formattedPix = {
                    txid: pix.txid,
                    amount: parseFloat(pix.valor),
                    date: new Date(pix.horario || Date.now()),
                    payer: pix.infoPagador || pix.pagador || "Não informado",
                    status: "recebido",
                };

                console.log("💸 Pix recebido:", formattedPix);
                io.emit("pix-received", formattedPix);

                // 🔧 Processa de forma assíncrona (não bloqueia resposta)
                processPixTransaction(formattedPix, io);
            }
        }
    } catch (err) {
        console.error("❌ Erro ao processar webhook:", err);
        res.status(500).json({ mensagem: "Erro ao processar notificação" });
    }
};

/**
 * 💰 Processa e aplica um Pix recebido a um pacote e suas sessões.
 * - Cria Payment principal
 * - Chama distributePayments() para atualizar sessões e appointments
 */
async function processPixTransaction(formattedPix, io) {
    const mongoSession = await mongoose.startSession();

    try {
        await mongoSession.startTransaction();

        const { txid, amount, payer } = formattedPix;

        // ⚠️ Evita duplicidade (idempotência)
        const existingPayment = await Payment.findOne({ txid, status: "paid" }).session(mongoSession);
        if (existingPayment) {
            console.warn(`⚠️ Pagamento PIX ${txid} já processado anteriormente.`);
            await mongoSession.abortTransaction();
            return;
        }

        // 🔹 Localiza o pacote associado (via txid)
        let pkg = await Package.findOne({ txid }).populate("sessions").session(mongoSession);
        if (!pkg) {
            const approxDate = new Date();
            const pkgFallback = await Package.findOne({
                totalValue: { $gte: amount - 1, $lte: amount + 1 },
                createdAt: { $gte: new Date(approxDate.getTime() - 3 * 60 * 60 * 1000) }, // 3h antes
            }).populate("sessions").session(mongoSession);

            if (pkgFallback) {
                console.warn(`⚠️ Pacote localizado por valor aproximado (fallback): ${pkgFallback._id}`);
                pkg = pkgFallback;
            }
        }


        // 🔹 Cria registro principal de pagamento
        const paymentDate = moment().tz("America/Sao_Paulo").startOf('day').toDate();
        const paymentDoc = new Payment({
            package: pkg._id,
            patient: pkg.patient,
            doctor: pkg.doctor,
            txid,
            amount,
            paymentMethod: "pix",
            status: "paid",
            paidAt: new Date(),  // 🔒 Obrigatório quando status='paid'
            serviceType: "package_session",
            kind: "package_receipt",
            notes: `Pagamento via PIX - ${payer}`,
            paymentDate: paymentDate,
            financialDate: paymentDate, // 🎯 Alinhado com paymentDate
            updatedAt: new Date()
        });
        await paymentDoc.save({ session: mongoSession });

        // 🔹 Distribui valor entre sessões do pacote
        const updatedPackage = await distributePayments(
            pkg._id,
            amount,
            mongoSession,
            paymentDoc._id
        );

        // 🔹 Atualiza dados financeiros do pacote
        pkg.payments.push(paymentDoc._id);
        pkg.totalPaid = (pkg.totalPaid || 0) + amount;
        
        // Recalcula balance baseado nas sessões realizadas (sessionsDone), não no total do pacote
        // Prepaid: totalValue - (sessionsDone * sessionValue) = crédito restante
        // Per-session: (sessionsDone * sessionValue) - totalPaid = dívida (positivo) ou crédito (negativo)
        const sessionsDone = pkg.sessionsDone || 0;
        const usedValue = sessionsDone * (pkg.sessionValue || 0);
        const totalValue = pkg.totalValue || (pkg.totalSessions * pkg.sessionValue) || 0;
        
        // 🎯 Inferir prepaid por model (V2) ou paymentType (legado)
        const isPrepaid = pkg.model === 'prepaid' || pkg.paymentType === 'full';
        
        if (isPrepaid) {
            pkg.balance = totalValue - usedValue; // Crédito restante (pode ser negativo se usou mais)
        } else {
            pkg.balance = usedValue - pkg.totalPaid; // Dívida (positivo) ou crédito (negativo)
        }
        
        pkg.financialStatus =
            Math.abs(pkg.balance) < 0.01
                ? "paid"
                : pkg.totalPaid > 0
                    ? pkg.balance < 0 ? "paid_with_credit" : "partially_paid"
                    : "unpaid";
        pkg.lastPaymentAt = new Date();

        await pkg.save({ session: mongoSession });
        await mongoSession.commitTransaction();

        console.log(`✅ PIX ${txid} aplicado com sucesso ao pacote ${pkg._id}`);

        // 🔔 Emite evento de atualização em tempo real
        io.emit("paymentUpdate", {
            type: "pix",
            txid,
            packageId: pkg._id,
            patient: pkg.patient,
            doctor: pkg.doctor,
            amount,
            method: "pix",
            totalPaid: pkg.totalPaid,
            balance: pkg.balance,
            financialStatus: pkg.financialStatus,
            timestamp: new Date(),
        });

    } catch (err) {
        await mongoSession.abortTransaction();
        console.error(`❌ Erro ao aplicar PIX ${formattedPix.txid}:`, err);
    } finally {
        await mongoSession.endSession();
    }
}
