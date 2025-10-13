import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import https from "https";

dotenv.config();

const {
    SICOOB_CLIENT_ID,
    SICOOB_CLIENT_SECRET,
    SICOOB_AUTH_URL,
    SICOOB_API_BASE_URL,
    SICOOB_PFX_PATH,
    SICOOB_PFX_PASSWORD,
    SICOOB_PIX_KEY,
    SICOOB_WEBHOOK_URL,
} = process.env;

if (!fs.existsSync(SICOOB_PFX_PATH)) {
    console.error(`❌ Certificado não encontrado: ${SICOOB_PFX_PATH}`);
    process.exit(1);
}

const httpsAgent = new https.Agent({
    pfx: fs.readFileSync(SICOOB_PFX_PATH),
    passphrase: SICOOB_PFX_PASSWORD,
    rejectUnauthorized: false, // true em produção se o CA estiver válido
});

async function run() {
    try {
        console.log("🔐 Gerando token OAuth2 no Sicoob...");

        const tokenRes = await axios.post(
            SICOOB_AUTH_URL,
            new URLSearchParams({
                grant_type: "client_credentials",
                client_id: SICOOB_CLIENT_ID,
                client_secret: SICOOB_CLIENT_SECRET,
                scope: "pix.read pix.write webhook.read webhook.write cob.read cob.write",
            }),
            {
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                httpsAgent,
            }
        );

        const token = tokenRes.data.access_token;
        console.log("✅ Token gerado com sucesso!");
        console.log("🔍 Escopos do token:", tokenRes.data.scope || "(nenhum)");

        // =============================
        // 1️⃣ Registrar webhook PIX
        // =============================
        const putUrl = `${SICOOB_API_BASE_URL}/webhook/${SICOOB_PIX_KEY}`;
        console.log("\n🔧 Registrando webhook em:", putUrl);

        try {
            const putRes = await axios.put(
                putUrl,
                { webhookUrl: SICOOB_WEBHOOK_URL },
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        "Content-Type": "application/json",
                    },
                    httpsAgent,
                }
            );
            console.log("📥 Webhook registrado com sucesso:", putRes.data);
        } catch (err) {
            console.error("❌ Erro ao registrar webhook:", err.response?.data || err.message);
        }

        // =============================
        // 2️⃣ Consultar webhook
        // =============================
        const getUrl = `${SICOOB_API_BASE_URL}/webhook/${SICOOB_PIX_KEY}`;
        console.log("\n🔍 Consultando webhook em:", getUrl);

        try {
            const getRes = await axios.get(getUrl, {
                headers: { Authorization: `Bearer ${token}` },
                httpsAgent,
            });
            console.log("📡 Consulta webhook:", getRes.data);
        } catch (err) {
            console.error("❌ Erro ao consultar webhook:", err.response?.data || err.message);
        }
    } catch (err) {
        console.error("❌ Erro Sicoob:", err.response?.data || err.message);
    }
}

run();
