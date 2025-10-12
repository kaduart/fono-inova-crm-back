// services/sicoobAuth.js
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import https from "https";
dotenv.config();

let cachedToken = null;
let cachedExpiration = null;

/**
 * 🔐 Gera token de acesso via certificado (sem client_secret)
 */
export const getSicoobAccessToken = async () => {
  const now = Date.now();

  if (cachedToken && cachedExpiration && now < cachedExpiration) {
    return cachedToken;
  }

  try {
    const formData = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.SICOOB_CLIENT_ID,
      scope: "pix.read pix.write webhook.write",
    });

    const httpsAgent = new https.Agent({
      cert: fs.readFileSync(process.env.SICOOB_CERT_PATH),
      key: fs.readFileSync(process.env.SICOOB_KEY_PATH),
      passphrase: process.env.SICOOB_PFX_PASSWORD,
      rejectUnauthorized: false, // deixe true depois que validar tudo
    });

    console.log("🌐 Solicitando token via certificado mTLS...");

    const { data } = await axios.post(process.env.SICOOB_AUTH_URL, formData, {
      httpsAgent,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    cachedToken = data.access_token;
    cachedExpiration = now + (data.expires_in - 60) * 1000; // 1 min de margem

    console.log("✅ Token Sicoob gerado com sucesso!");
    return cachedToken;
  } catch (error) {
    console.error("❌ Erro ao obter token Sicoob:", error.response?.data || error.message);
    throw new Error("Falha na autenticação com o Sicoob");
  }
};
