import { createClient } from "redis";

const isProduction = process.env.NODE_ENV === "production";
let redisClient;

// ===============================
// 🔌 Configuração do Redis Client
// ===============================
if (isProduction) {
    // 🟢 PRODUÇÃO → Upstash Redis (Render)
    redisClient = createClient({
        url: process.env.REDIS_URL, // rediss://default:senha@host:6379
        socket: {
            tls: true,
            rejectUnauthorized: false, // evita erro de certificado self-signed
        },
    });
} else {
    // 🧑‍💻 DESENVOLVIMENTO LOCAL → Redis rodando em localhost:6379
    redisClient = createClient({
        socket: {
            host: process.env.REDIS_HOST || "127.0.0.1",
            port: process.env.REDIS_PORT || 6379,
        },
    });
}

// ===============================
// 🚀 Eventos de Conexão
// ===============================
redisClient.on("connect", () => {
    console.log(`✅ Redis conectado (${isProduction ? "Upstash (produção)" : "Local (desenvolvimento)"})`);
});

redisClient.on("error", (err) => {
    console.error("❌ Erro Redis:", err);
});

// ===============================
// 🚦 Função de inicialização + teste de saúde
// ===============================
export async function startRedis() {
    try {
        await redisClient.connect();
        console.log("🚀 Redis conectado e pronto para uso!");

        // 🩺 Teste de saúde
        console.log("🧠 Testando conexão Redis...");
        await redisClient.set("redis_health_check", "ok", { EX: 10 });
        const value = await redisClient.get("redis_health_check");

        if (value === "ok") {
            console.log("💚 Redis respondeu corretamente ao teste de saúde (ping/set/get).");
        } else {
            console.warn("⚠️ Redis conectado, mas não respondeu ao teste de saúde!");
        }
    } catch (error) {
        console.error("❌ Falha ao conectar Redis:", error.message);
    }
}

export default redisClient;
