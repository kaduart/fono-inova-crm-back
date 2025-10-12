import axios from "axios";
import dotenv from "dotenv";
import { resolve } from "path";

// 🔧 força o carregamento do .env na raiz do backend
dotenv.config({ path: resolve("../.env") });
console.log("📁 .env carregado de:", resolve("../.env"));
console.log("🔗 SICOOB_AUTH_URL:", process.env.SICOOB_AUTH_URL);

import { getSicoobAccessToken } from "../services/sicoobAuth.js";


const testRegisterWebhook = async () => {
    try {
        console.log("🚀 Iniciando teste de registro de webhook no Sicoob...");

        // 1️⃣ Obtém o token de acesso válido
        const token = await getSicoobAccessToken();
        if (!token) throw new Error("Token não foi retornado!");

        console.log("✅ Token obtido com sucesso!");
        console.log("🔑 Primeiros caracteres:", token.slice(0, 25) + "...");

        // 2️⃣ Configura dados do webhook
        const chavePix = process.env.SICOOB_PIX_KEY;
        const webhookUrl = process.env.SICOOB_WEBHOOK_URL;
        const url = `${process.env.SICOOB_API_BASE_URL}/webhook/${chavePix}`;

        console.log(`\n📡 Enviando requisição PUT para:\n${url}`);
        console.log(`🔗 Webhook URL: ${webhookUrl}`);

        // 3️⃣ Faz o PUT na API
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

        console.log("\n✅ Webhook registrado com sucesso!");
        console.log("📄 Resposta da API:", response.data);

    } catch (error) {
        console.error("\n❌ Erro ao registrar webhook:");
        console.error(error.response?.data || error.message);
    }
};

testRegisterWebhook();
