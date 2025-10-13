import axios from "axios";
import dotenv from "dotenv";
import { getIo } from "../config/socket.js";
import Payment from "../models/Payment.js";
import { getSicoobAccessToken } from "../services/sicoobAuth.js";

dotenv.config();

/**
 * ============================================================
 * 📦 1️⃣ REGISTRA WEBHOOK PIX NO SICOOB
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
 * 💸 2️⃣ LISTA PIX RECEBIDOS
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
 * 🧾 3️⃣ CONSULTA COBRANÇA ESPECÍFICA
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
 * ⚡ 4️⃣ RECEBE NOTIFICAÇÕES PIX (WEBHOOK REAL)
 * ============================================================
 */
export const webhookPixHandler = async (req, res) => {
  try {
    const { pix } = req.body;

    if (!pix || !Array.isArray(pix)) {
      console.warn("⚠️ Payload inválido recebido no webhook:", req.body);
      return res.status(400).json({ success: false, message: "Payload inválido" });
    }

    console.log("📩 Notificação PIX recebida:", JSON.stringify(pix, null, 2));

    res.status(200).json({ success: true });

    const io = getIo();
    if (!io) {
      console.error("❌ Socket.IO não inicializado");
      return;
    }

    for (const p of pix) {
      const txid = p?.txid || `no-txid-${Date.now()}`;
      const valor = parseFloat(p?.valor) || 0;

      // 🔍 Busca pagamento pendente aproximado
      const payment = await Payment.findOne({
        status: "pending",
        paymentMethod: "pix",
        amount: { $gte: valor - 1, $lte: valor + 1 },
      }).sort({ createdAt: -1 });

      if (payment) {
        payment.status = "paid";
        payment.notes = `PIX confirmado via webhook TXID: ${txid}`;
        await payment.save();

        console.log(`💰 Pagamento ${payment._id} atualizado como 'paid'`);
      } else {
        console.warn("⚠️ Nenhum pagamento pendente encontrado para o PIX:", txid);
      }

      const payload = {
        id: txid,
        amount: valor,
        payer: p?.infoPagador || "Desconhecido",
        date: p?.horario || new Date().toISOString(),
        key: p?.chave || "indefinida",
        status: "received",
      };

      console.log("⚡ Emitindo evento 'pix-received':", payload);
      io.emit("pix-received", payload);
    }
  } catch (error) {
    console.error("❌ Erro ao processar webhook PIX:", error.message);
    if (!res.headersSent)
      res.status(500).json({ success: false, message: "Erro interno no webhook PIX" });
  }
};
