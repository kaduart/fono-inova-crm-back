// services/sicoobService.js
import axios from "axios";
import fs from "fs";
import https from "https";
import dotenv from "dotenv";
import { getSicoobAccessToken } from "./sicoobAuth.js";

dotenv.config();

const API_BASE = process.env.SICOOB_API_BASE_URL;
const PIX_KEY = process.env.SICOOB_PIX_KEY;

// 🔒 Agente HTTPS usando certificado .pfx único
const httpsAgent = new https.Agent({
  pfx: fs.readFileSync(process.env.SICOOB_PFX_PATH),
  passphrase: process.env.SICOOB_PFX_PASSWORD,
  rejectUnauthorized: false, // deixe false até validar no prod
});

/**
 * ✅ Registra o webhook Pix no Sicoob
 */
export const registerWebhook = async () => {
  const token = await getSicoobAccessToken();
  const url = `${API_BASE}/webhook/${PIX_KEY}`;
  const webhookUrl =
    process.env.SICOOB_WEBHOOK_URL ||
    "https://fono-inova-crm-back.onrender.com/api/pix/webhook";

  const body = { webhookUrl };

  try {
    const response = await axios.put(url, body, {
      httpsAgent,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    console.log("✅ Webhook registrado com sucesso:", response.data);
    return response.data;
  } catch (error) {
    console.error(
      "❌ Erro ao registrar webhook:",
      error.response?.data || error.message
    );
    throw error;
  }
};

/**
 * 📬 Consulta o webhook atual (para debug)
 */
export const getWebhookInfo = async () => {
  const token = await getSicoobAccessToken();
  const url = `${API_BASE}/webhook/${PIX_KEY}`;

  try {
    const response = await axios.get(url, {
      httpsAgent,
      headers: { Authorization: `Bearer ${token}` },
    });

    console.log("📡 Webhook atual:", response.data);
    return response.data;
  } catch (error) {
    console.error(
      "❌ Erro ao consultar webhook:",
      error.response?.data || error.message
    );
    throw error;
  }
};
