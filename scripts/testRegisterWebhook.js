import fs from "fs";
import https from "https";
import axios from "axios";
import dotenv from "dotenv";
import path from "path"; // ✅ adiciona esta linha para corrigir o erro

// 🧩 Corrigir caminho absoluto do .env (sobe um nível a partir da pasta /scripts)
dotenv.config({ path: path.resolve(process.cwd(), "../.env") });

console.log("📁 .env carregado de:", path.resolve(process.cwd(), "../.env"));
console.log("🔗 SICOOB_AUTH_URL:", process.env.SICOOB_AUTH_URL);

const baseDir = path.resolve(process.cwd(), "../"); // sobe da pasta /scripts para /backend
const CERT_PATH = path.join(baseDir, "certs/certificado_publico.pem");
const KEY_PATH = path.join(baseDir, "certs/certificado_privado.pem");
const CA_PATH = path.join(baseDir, "certs/ca.pem");

const PIX_KEY = process.env.SICOOB_PIX_KEY;
const WEBHOOK_URL = process.env.SICOOB_WEBHOOK_URL;
const CLIENT_ID = process.env.SICOOB_CLIENT_ID;

const SCOPE = "pix.read cobv.read lotecobv.write payloadlocation.read webhook.write cob.read";

async function getSicoobAccessToken() {
  console.log("🚀 Solicitando token com mTLS...");

  const cert = fs.readFileSync(CERT_PATH);
  const key = fs.readFileSync(KEY_PATH);
  const ca = fs.existsSync(CA_PATH) ? fs.readFileSync(CA_PATH) : null;

  const httpsAgent = new https.Agent({
    cert,
    key,
    ca,
    rejectUnauthorized: true,
  });

  try {
    const params = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      scope: SCOPE,
    });

    const response = await axios.post(process.env.SICOOB_AUTH_URL, params, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      httpsAgent,
    });

    console.log("✅ Token obtido com sucesso!");
    return response.data.access_token;
  } catch (err) {
    console.error("❌ Erro ao obter token Sicoob:", err.response?.data || err.message);
    throw new Error("Falha na autenticação mTLS com o Sicoob");
  }
}

async function registerWebhook() {
  console.log("🚀 Iniciando registro de webhook PIX...");

  const cert = fs.readFileSync(CERT_PATH);
  const key = fs.readFileSync(KEY_PATH);
  const ca = fs.existsSync(CA_PATH) ? fs.readFileSync(CA_PATH) : null;

  const httpsAgent = new https.Agent({
    cert,
    key,
    ca,
    rejectUnauthorized: true,
  });

  try {
    const token = await getSicoobAccessToken();

    const response = await axios.put(
      `${process.env.SICOOB_API_BASE_URL}/webhook/${PIX_KEY}`,
      { webhookUrl: WEBHOOK_URL },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        httpsAgent,
      }
    );

    console.log("✅ Webhook registrado com sucesso!");
    console.log("📡 Resposta:", response.data);
  } catch (err) {
    console.error("❌ Erro ao registrar webhook:", err.response?.data || err.message);
  }
}

registerWebhook();
