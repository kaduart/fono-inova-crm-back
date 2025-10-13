// src/services/redisClient.js
import { createClient } from "redis";

const isProduction = process.env.NODE_ENV === "production";
let redisClient;

// ===============================
// 🔌 Configuração do Redis Client
// ===============================
if (isProduction) {
    console.log("🌍 Ambiente de produção detectado");
    console.log("🔗 REDIS_URL:", process.env.REDIS_URL ? "✅ configurada" : "❌ ausente");

    // 🟢 PRODUÇÃO → Upstash Redis (Render)
    redisClient = createClient({
        url: process.env.REDIS_URL, // rediss://default:senha@host:port
        socket: {
            tls: true, // obrigatório no Upstash
            rejectUnauthorized: false, // evita falha de certificado TLS
            keepAlive: 10000, // mantém conexão viva
            connectTimeout: 15000, // aumenta tolerância para Render
            lazyConnect: true, // 👈 impede crash no startup (conecta sob demanda)
            reconnectStrategy: (retries) => {
                console.log(`🔁 Tentando reconectar ao Redis (tentativa ${retries})...`);
                return Math.min(retries * 1000, 15000); // tenta até 15s entre reconexões
            },
        },
    });
} else {
    console.log("🧑‍💻 Ambiente de desenvolvimento detectado");
    redisClient = createClient({
        socket: {
            host: process.env.REDIS_HOST || "127.0.0.1",
            port: process.env.REDIS_PORT || 6379,
        },
    });
}

// ✅ Helper para reaproveitar a instância do Redis em outros módulos
export function getRedis() {
    return redisClient;
}

// ===============================
// 🚦 Eventos de Conexão
// ===============================
redisClient.on("connect", () => {
    console.log(
        `✅ Redis conectado (${isProduction ? "Upstash (produção)" : "Local (desenvolvimento)"})`
    );
});

redisClient.on("ready", () => {
    console.log("🧠 Redis pronto para uso!");
});

redisClient.on("error", (err) => {
    if (err.code === "ECONNRESET" || err.code === "EPIPE" || err.code === "ETIMEDOUT") {
        console.warn("⚠️ Conexão Redis perdida (será retomada automaticamente).");
    } else {
        console.error("❌ Erro Redis:", err.message);
    }
});

redisClient.on("end", () => {
    console.warn("⚠️ Conexão Redis encerrada (aguardando reconexão).");
});

// ===============================
// 🚀 Inicialização + teste de saúde
// ===============================
export async function startRedis() {
    try {
        console.log("🌐 Iniciando conexão Redis...");
        await redisClient.connect(); // conecta sob demanda
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
