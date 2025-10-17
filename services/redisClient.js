import { createClient } from "redis";

// ===================================================
// 🔍 Diagnóstico inicial
// ===================================================
const envMode = process.env.NODE_ENV || "development";
const hasUpstash = Boolean(process.env.REDIS_URL?.startsWith("rediss://"));

console.log(`🌍 Modo detectado: ${envMode}`);
console.log(`🔗 Upstash URL detectada: ${hasUpstash ? "✅ Sim" : "❌ Não"}`);

let redisClient;
let lastErrorTime = null;

// ===================================================
// 🔌 Criação do cliente (produção vs dev)
// ===================================================
const commonSocketConfig = {
    reconnectStrategy: (retries) => {
        console.warn(`🔁 Tentando reconectar ao Redis (tentativa ${retries})...`);
        return Math.min(retries * 1000, 15000);
    },
    keepAlive: 15000,
    connectTimeout: 15000,
};

if (hasUpstash) {
    console.log("🚀 Conectando ao Redis (Upstash - Produção)...");

    redisClient = createClient({
        url: process.env.REDIS_URL,
        socket: {
            tls: true,
            rejectUnauthorized: false,
            ...commonSocketConfig,
        },
    });
} else {
    console.log("🧑‍💻 Conectando ao Redis Local (Desenvolvimento)...");

    redisClient = createClient({
        socket: {
            host: process.env.REDIS_HOST || "127.0.0.1",
            port: process.env.REDIS_PORT || 6379,
            ...commonSocketConfig,
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
    const now = Date.now();
    if (!lastErrorTime || now - lastErrorTime > 10000) {
        console.error("❌ Erro Redis:", err.message);
        console.trace("📍 Origem do erro Redis:");
        lastErrorTime = now;
    }
});

// ===================================================
// 🚀 Inicialização + teste de saúde
// ===================================================
export async function startRedis() {
    try {
        await redisClient.connect();

        console.log("🚀 Redis conectado e validado!");

        // Health check leve (uma vez só)
        await redisClient.set("redis_health_check", "ok", { EX: 10 });
        const test = await redisClient.get("redis_health_check");
        console.log(`💚 Health Check Redis: ${test === "ok" ? "OK" : "Falhou"}`);

        // Mantém a conexão viva sem estourar limites
        setInterval(async () => {
            try {
                await redisClient.ping();
            } catch (err) {
                console.warn("⚠️ Redis ping falhou:", err.message);
            }
        }, hasUpstash ? 300000 : 60000); // 5min em Upstash, 1min local
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
