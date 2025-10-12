// services/sicoobService.js
import axios from "axios";
import { getSicoobAccessToken } from "./sicoobAuth.js";
import dotenv from "dotenv";
dotenv.config();

const API_BASE = process.env.SICOOB_API_BASE_URL;
const PIX_KEY = process.env.SICOOB_PIX_KEY;

/**
 * Registra o webhook para receber notificações de PIX.
 */
export const registerWebhook = async () => {
  const token = await getSicoobAccessToken();
  const url = `${API_BASE}/webhook/${PIX_KEY}`;
  const body = { webhookUrl: process.env.SICOOB_WEBHOOK_URL };

  try {
    const response = await axios.put(url, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    console.log("✅ Webhook registrado com sucesso:", response.data);
    return response.data;
  } catch (error) {
    console.error("❌ Erro ao registrar webhook:", error.response?.data || error.message);
    throw error;
  }
};

/**
 * Lista os PIX recebidos.
 */
export const listReceivedPixes = async (inicio, fim) => {
  const token = await getSicoobAccessToken();
  const url = `${API_BASE}/pix?inicio=${inicio}&fim=${fim}`;

  try {
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    console.log(`📥 ${response.data.pix?.length || 0} PIX encontrados`);
    return response.data.pix || [];
  } catch (error) {
    console.error("❌ Erro ao listar PIX:", error.response?.data || error.message);
    throw error;
  }
};

/**
 * Consulta cobrança por TXID.
 */
export const getCobranca = async (txid) => {
  const token = await getSicoobAccessToken();
  const url = `${API_BASE}/cob/${txid}`;

  try {
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.data;
  } catch (error) {
    console.error("❌ Erro ao consultar cobrança:", error.response?.data || error.message);
    throw error;
  }
};
