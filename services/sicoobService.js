// services/sicoobService.js
import axios from "axios";
import fs from "fs";
import https from "https";
import { getSicoobAccessToken } from "./sicoobAuth.js";
import dotenv from "dotenv";
dotenv.config();

const API_BASE = process.env.SICOOB_API_BASE_URL;
const PIX_KEY = process.env.SICOOB_PIX_KEY;

// 🔒 Agente HTTPS com mTLS
const httpsAgent = new https.Agent({
  cert: fs.readFileSync(process.env.SICOOB_CERT_PATH),
  key: fs.readFileSync(process.env.SICOOB_KEY_PATH),
  passphrase: process.env.SICOOB_PFX_PASSWORD,
  rejectUnauthorized: false, // 👉 mantém compatibilidade, pode mudar pra true depois que validar
});

/**
 * ✅ Registra o webhook de produção
 */
export const registerWebhook = async () => {
  const token = await getSicoobAccessToken();
  const url = `${API_BASE}/webhook/${PIX_KEY}`;
  const body = { webhookUrl: process.env.SICOOB_WEBHOOK_URL };

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
