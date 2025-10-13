import { createClient } from "redis";

// ===================================================
// 🔍 Diagnóstico inicial
// ===================================================
const envMode = process.env.NODE_ENV || "development";
const hasUpstash = Boolean(process.env.REDIS_URL?.startsWith("rediss://"));

console.log(`🌍 Modo detectado: ${envMode}`);
console.log(`🔗 Upstash URL detectada: ${hasUpstash ? "✅ Sim" : "❌ Não"}`);

let redisClient;

// ===================================================
// 🔌 Criação do cliente (produção vs dev)
// ===================================================
if (hasUpstash) {
    console.log("🚀 Conectando ao Redis (Upstash - Produção)...");

    redisClient = createClient({
        url: process.env.REDIS_URL,
        socket: {
            tls: true, // Upstash exige TLS
            rejectUnauthorized: false,
            keepAlive: 10000,
            connectTimeout: 15000, // tolerância para Render
            reconnectStrategy: (retries) => {
                console.warn(`🔁 Tentando reconectar ao Upstash (tentativa ${retries})...`);
                return Math.min(retries * 1000, 15000);
            },
        },
    });
} else {
    console.log("🧑‍💻 Conectando ao Redis Local (Desenvolvimento)...");

    redisClient = createClient({
        socket: {
            host: process.env.REDIS_HOST || "127.0.0.1",
            port: process.env.REDIS_PORT || 6379,
        },
    });
}

// ===================================================
// ⚙️ Eventos globais
// ===================================================
redisClient.on("connect", () => {
    console.log(`✅ Redis conectado (${hasUpstash ? "Upstash" : "Local"})`);
});

redisClient.on("ready", () => console.log("🧠 Redis pronto para uso!"));
redisClient.on("end", () => console.warn("⚠️ Conexão Redis encerrada."));
redisClient.on("reconnecting", () => console.log("🔁 Tentando reconexão ao Redis..."));

redisClient.on("error", (err) => {
    console.error("❌ Erro Redis:", err.message);
    console.trace("📍 Origem do erro Redis:");
});

// ===================================================
// 🚀 Inicialização + teste de saúde
// ===================================================
export async function startRedis() {
    try {
        await redisClient.connect();

        console.log("🚀 Redis conectado e validado!");
        await redisClient.set("redis_health_check", "ok", { EX: 5 });
        const test = await redisClient.get("redis_health_check");
        console.log(`💚 Health Check Redis: ${test === "ok" ? "OK" : "Falhou"}`);
    } catch (err) {
        console.error("❌ Falha ao conectar Redis:", err.message);
    }
}

// ===================================================
// 🧩 Helper para reaproveitar a instância
// ===================================================
export function getRedis() {
    return redisClient;
}

export default redisClient;
