import mongoose from "mongoose";
import { getIo } from "../config/socket.js";
import Package from "../models/Package.js";
import Payment from "../models/Payment.js";
import { distributePayments } from "../services/distributePayments.js";

export const handlePixWebhook = async (req, res) => {
  try {
    const payload = req.body;
    console.log("🔔 Notificação PIX recebida:", JSON.stringify(payload, null, 2));

    // ✅ Resposta imediata ao Sicoob
    res.status(200).json({ mensagem: "Notificação recebida com sucesso" });

    if (!payload.pix || !Array.isArray(payload.pix)) {
      console.warn("⚠️ Payload inválido recebido:", payload);
      return;
    }

    const io = getIo();

    // 🔹 Processa cada transação PIX individualmente
    for (const pix of payload.pix) {
      const formattedPix = {
        txid: pix.txid,
        amount: parseFloat(pix.valor),
        date: new Date(pix.horario || Date.now()),
        payer: pix.infoPagador || pix.pagador || "Não informado",
        status: "recebido",
      };

      console.log("💸 Pix processado:", formattedPix);
      io.emit("pix-received", formattedPix); // exibe badge de "PIX recebido"

      // 🔧 Processar em background (não trava o retorno ao Sicoob)
      processPixTransaction(formattedPix, io);
    }
  } catch (err) {
    console.error("❌ Erro ao processar webhook:", err);
    res.status(500).json({ mensagem: "Erro ao processar notificação" });
  }
};

/**
 * 💰 Aplica um PIX recebido aos registros do sistema:
 * - Cria Payment principal (package_receipt)
 * - Distribui valor entre sessões
 * - Atualiza Package (totalPaid, balance, financialStatus)
 * - Emite evento "paymentUpdate" em tempo real
 */
async function processPixTransaction({ txid, amount, payer, date }, io) {
  const mongoSession = await mongoose.startSession();

  try {
    await mongoSession.startTransaction();

    // ⚠️ Evita duplicidade
    const existingPayment = await Payment.findOne({ txid, status: "paid" }).session(mongoSession);
    if (existingPayment) {
      console.warn(`⚠️ PIX ${txid} já processado anteriormente.`);
      await mongoSession.abortTransaction();
      return;
    }

    // 🔹 Localiza o pacote associado (por txid ou valor aproximado)
    let pkg = await Package.findOne({ txid }).populate("sessions").session(mongoSession);
    if (!pkg) {
      const now = new Date();
      const pkgFallback = await Package.findOne({
        totalValue: { $gte: amount - 1, $lte: amount + 1 },
        createdAt: { $gte: new Date(now.getTime() - 3 * 60 * 60 * 1000) }, // 3h antes
      }).populate("sessions").session(mongoSession);

      if (pkgFallback) {
        console.warn(`⚠️ Pacote localizado por fallback de valor: ${pkgFallback._id}`);
        pkg = pkgFallback;
      } else {
        console.warn(`⚠️ Nenhum pacote encontrado para PIX TXID: ${txid}`);
        await mongoSession.abortTransaction();
        return;
      }
    }

    // 🔹 Cria o pagamento principal (recibo do pacote)
    const paymentDoc = new Payment({
      package: pkg._id,
      patient: pkg.patient,
      doctor: pkg.doctor,
      txid,
      amount,
      paymentMethod: "pix",
      status: "paid",
      serviceType: "package_session",
      kind: "package_receipt",
      notes: `Pagamento via PIX - ${payer}`,
      paymentDate: date || new Date(),
    });
    await paymentDoc.save({ session: mongoSession });

    // 🔹 Distribui o valor entre as sessões do pacote
    await distributePayments(pkg._id, amount, mongoSession, paymentDoc._id);

    // 🔹 Atualiza o pacote (resumo financeiro)
    pkg.totalPaid = (pkg.totalPaid || 0) + amount;
    pkg.balance = pkg.totalSessions * pkg.sessionValue - pkg.totalPaid;
    pkg.financialStatus =
      pkg.balance <= 0 ? "paid" : pkg.totalPaid > 0 ? "partially_paid" : "unpaid";
    pkg.lastPaymentAt = new Date();
    pkg.payments.push(paymentDoc._id);

    await pkg.save({ session: mongoSession });
    await mongoSession.commitTransaction();

    console.log(`✅ PIX ${txid} aplicado com sucesso ao pacote ${pkg._id}`);

    // 🔔 Emite evento em tempo real para o front
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
    console.error(`❌ Erro ao aplicar PIX ${txid}:`, err);
  } finally {
    await mongoSession.endSession();
  }
}
