import axios from "axios";
import dotenv from "dotenv";
import { getSicoobAccessToken } from "../services/sicoobAuth.js";
dotenv.config();

/**
 * ============================================================
 * 📦 1️⃣ REGISTRA O WEBHOOK PIX NO SICOOB
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
          client_id: process.env.SICOOB_CLIENT_ID,
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
 * 💸 2️⃣ LISTA PIX RECEBIDOS (para testes manuais)
 * ============================================================
 */
export const listPixHandler = async (req, res) => {
  try {
    const token = await getSicoobAccessToken();

    const url = `${process.env.SICOOB_API_BASE_URL}/pix`;

    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        client_id: process.env.SICOOB_CLIENT_ID,
      },
    });

    console.log("📦 PIX recebidos:", response.data);

    res.status(200).json({
      success: true,
      data: response.data,
    });
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
 * 🧾 3️⃣ CONSULTA COBRANÇA ESPECÍFICA POR TXID
 * ============================================================
 */
export const getCobrancaHandler = async (req, res) => {
  try {
    const { txid } = req.params;
    const token = await getSicoobAccessToken();

    const url = `${process.env.SICOOB_API_BASE_URL}/cob/${txid}`;

    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        client_id: process.env.SICOOB_CLIENT_ID,
      },
    });

    console.log("📄 Detalhes da cobrança:", response.data);

    res.status(200).json({
      success: true,
      data: response.data,
    });
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
 * ⚡ 4️⃣ RECEBE NOTIFICAÇÕES PIX (WEBHOOK)
 * ============================================================
 */
export const webhookPixHandler = async (req, res) => {
  try {
    console.log("📩 Notificação PIX recebida:", req.body);

    // Aqui você pode tratar a notificação (ex: atualizar pagamento no sistema)
    // Exemplo:
    // const pix = req.body.pix[0];
    // await Payment.updateOne({ e2eid: pix.endToEndId }, { status: "paid" });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error("❌ Erro ao processar webhook PIX:", error.message);
    res.status(500).json({ success: false, message: "Erro interno" });
  }
};
