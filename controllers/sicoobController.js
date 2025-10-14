import axios from "axios";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { getIo } from "../config/socket.js";
import Package from "../models/Package.js";
import Payment from "../models/Payment.js";
import { distributePayments } from "../services/distributePayments.js";
import { getSicoobAccessToken } from "../services/sicoobAuth.js";

dotenv.config();

/**
 * ============================================================
 * 1️⃣ REGISTRA WEBHOOK PIX NO SICOOB
 * ============================================================
 */
export const registerWebhookHandler = async (req, res) => {
  try {
    const token = await getSicoobAccessToken();
    const chavePix = process.env.SICOOB_PIX_KEY;
    const webhookUrl = process.env.SICOOB_WEBHOOK_URL;
    const url = `${process.env.SICOOB_API_BASE_URL}/webhook/${chavePix}`;

    const response = await axios.put(
      url,
      { webhookUrl },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("✅ Webhook registrado com sucesso:", response.data);
    res.status(200).json({
      success: true,
      message: "Webhook registrado com sucesso",
      data: response.data,
    });
  } catch (error) {
    console.error("❌ Erro ao registrar webhook:", error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: "Falha ao registrar webhook",
      error: error.response?.data || error.message,
    });
  }
};

/**
 * ============================================================
 * 2️⃣ LISTA PIX RECEBIDOS
 * ============================================================
 */
export const listPixHandler = async (req, res) => {
  try {
    const token = await getSicoobAccessToken();
    const url = `${process.env.SICOOB_API_BASE_URL}/pix`;

    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    console.log("📦 PIX recebidos:", response.data);
    res.status(200).json({ success: true, data: response.data });
  } catch (error) {
    console.error("❌ Erro ao listar PIX:", error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: "Erro ao listar PIX",
      error: error.response?.data || error.message,
    });
  }
};

/**
 * ============================================================
 * 3️⃣ CONSULTA COBRANÇA ESPECÍFICA
 * ============================================================
 */
export const getCobrancaHandler = async (req, res) => {
  try {
    const { txid } = req.params;
    const token = await getSicoobAccessToken();
    const url = `${process.env.SICOOB_API_BASE_URL}/cob/${txid}`;

    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    console.log("📄 Detalhes da cobrança:", response.data);
    res.status(200).json({ success: true, data: response.data });
  } catch (error) {
    console.error("❌ Erro ao consultar cobrança:", error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: "Erro ao consultar cobrança",
      error: error.response?.data || error.message,
    });
  }
};

/**
 * ============================================================
 * 4️⃣ WEBHOOK REAL – RECEBE NOTIFICAÇÕES DO SICOOB (PIX)
 * ============================================================
 */
export const handlePixWebhook = async (req, res) => {
  try {
    const payload = req.body;
    console.log("🔔 Notificação PIX recebida:", JSON.stringify(payload, null, 2));

    // ✅ Retorno imediato ao Sicoob (obrigatório)
    res.status(200).json({ mensagem: "Notificação recebida com sucesso" });

    if (!payload.pix || !Array.isArray(payload.pix)) {
      console.warn("⚠️ Payload inválido recebido:", payload);
      return;
    }

    const io = getIo();

    // Processa cada transação
    for (const pix of payload.pix) {
      const formattedPix = {
        txid: pix.txid,
        amount: parseFloat(pix.valor),
        date: new Date(pix.horario || Date.now()),
        payer: pix.infoPagador || pix.pagador || "Não informado",
        status: "recebido",
      };

      console.log("💸 Pix processado:", formattedPix);
      io.emit("pix-received", formattedPix); // Emite evento em tempo real

      // 🔧 Processar sem travar resposta
      processPixTransaction(formattedPix, io);
    }
  } catch (err) {
    console.error("❌ Erro ao processar webhook:", err);
    res.status(500).json({ mensagem: "Erro ao processar notificação" });
  }
};

/**
 * ============================================================
 * 5️⃣ PROCESSA PIX (CRIA PAGAMENTO + DISTRIBUI)
 * ============================================================
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

    // 🔹 Localiza pacote vinculado
    let pkg = await Package.findOne({ txid }).populate("sessions").session(mongoSession);
    if (!pkg) {
      const now = new Date();
      pkg = await Package.findOne({
        totalValue: { $gte: amount - 1, $lte: amount + 1 },
        createdAt: { $gte: new Date(now.getTime() - 3 * 60 * 60 * 1000) }, // 3h antes
      }).populate("sessions").session(mongoSession);
    }

    if (!pkg) {
      console.warn(`⚠️ Nenhum pacote encontrado para TXID: ${txid}`);
      await mongoSession.abortTransaction();
      return;
    }

    // 🔹 Cria pagamento
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

    // 🔹 Distribui entre sessões
    await distributePayments(pkg._id, amount, mongoSession, paymentDoc._id);

    // 🔹 Atualiza pacote
    pkg.totalPaid = (pkg.totalPaid || 0) + amount;
    pkg.balance = pkg.totalSessions * pkg.sessionValue - pkg.totalPaid;
    pkg.financialStatus =
      pkg.balance <= 0 ? "paid" : pkg.totalPaid > 0 ? "partially_paid" : "unpaid";
    pkg.lastPaymentAt = new Date();
    pkg.payments.push(paymentDoc._id);
    await pkg.save({ session: mongoSession });

    await mongoSession.commitTransaction();

    console.log(`✅ PIX ${txid} aplicado com sucesso ao pacote ${pkg._id}`);

    // 🔔 Notifica o front-end em tempo real
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
