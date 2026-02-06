// services/sicoobAuth.js
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import https from "https";

dotenv.config();

let cachedToken = null;
let cachedExpiration = null;

/**
 * 🔐 Gera token de acesso ao Sicoob via certificado .pfx (sem client_secret)
 */
export const getSicoobAccessToken = async () => {
  const now = Date.now();

  // ♻️ Cache simples para evitar requisições repetidas
  if (cachedToken && cachedExpiration && now < cachedExpiration) {
    return cachedToken;
  }

  // Verifica se certificado existe
  if (!process.env.SICOOB_PFX_PATH || !fs.existsSync(process.env.SICOOB_PFX_PATH)) {
    throw new Error('Certificado Sicoob não configurado. PIX desabilitado.');
  }

  try {
    console.log("🌐 Solicitando token via certificado PFX mTLS...");

    const httpsAgent = new https.Agent({
      pfx: fs.readFileSync(process.env.SICOOB_PFX_PATH),
      passphrase: process.env.SICOOB_PFX_PASSWORD,
      rejectUnauthorized: false, // deixa false até validar o certificado no prod
    });

    // 🔑 O Sicoob usa client_credentials com escopo Pix e Webhook
    const formData = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.SICOOB_CLIENT_ID,
      scope:
        "pix.read pix.write cob.read cob.write cobv.read cobv.write lotecobv.read lotecobv.write payloadlocation.read payloadlocation.write webhook.read webhook.write",
    });

    const { data } = await axios.post(process.env.SICOOB_AUTH_URL, formData, {
      httpsAgent,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    cachedToken = data.access_token;
    cachedExpiration = now + (data.expires_in - 60) * 1000; // 1 min de margem

    console.log("✅ Token Sicoob gerado com sucesso!");
    console.log("🔍 Escopos do token:", formData.get("scope"));

    return cachedToken;
  } catch (error) {
    console.error(
      "❌ Erro ao obter token Sicoob:",
      error.response?.data || error.message
    );
    throw new Error("Falha na autenticação com o Sicoob (mTLS)");
  }
};
