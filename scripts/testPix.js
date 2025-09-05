import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import https from "https";
import getSicoobAccessToken from '../services/sicoobAuth.js';
dotenv.config();

const httpsAgent = new https.Agent({
    pfx: fs.readFileSync(process.env.SICOOB_PFX_PATH),
    passphrase: process.env.SICOOB_PFX_PASSWORD,
    rejectUnauthorized: true,
});

const testPixWebhook = async () => {
    try {
        const token = await getSicoobAccessToken();
        console.log("✅ Token obtido com sucesso:", token.substring(0, 20) + "...");

        // ⚠️ Troque pela sua chave Pix real cadastrada no Sicoob
        const chavePix = process.env.SICOOB_PIX_KEY;

        const url = `${process.env.SICOOB_API_BASE_URL}/webhook/${encodeURIComponent(chavePix)}`;

        const response = await axios.get(url, {
            headers: {
                Authorization: `Bearer ${token}`,
            },
            httpsAgent,
        });

        console.log("✅ Webhook recuperado com sucesso:");
        console.log(response.data);
    } catch (error) {
        console.error(
            "❌ Erro ao chamar API Pix:",
            error.response?.data || error.message
        );
    }
};

testPixWebhook();
