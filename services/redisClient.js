import { createClient } from "redis";

// 🔍 Diagnóstico inicial
const envMode = process.env.NODE_ENV || "development";
const hasUpstash = process.env.REDIS_URL?.startsWith("rediss://");
console.log(`🌍 Modo detectado: ${envMode}`);
console.log(`🔗 Upstash URL detectada: ${hasUpstash ? "✅ Sim" : "❌ Não"}`);

let redisClient;

// ✅ Helper para reaproveitar a instância do Redis em outros módulos
export function getRedis() {
    return redisClient;
}

if (hasUpstash) {
    console.log("🚀 Conectando ao Redis (Upstash - Produção)...");
    redisClient = createClient({
        url: process.env.REDIS_URL,
        socket: {
            tls: true,
            rejectUnauthorized: false,
            keepAlive: 10000,
            connectTimeout: 15000,
            reconnectStrategy: (retries) => Math.min(retries * 1000, 10000),
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

// 🚦 Inicializa
redisClient.on("connect", () => console.log("✅ Redis conectado!"));
redisClient.on("ready", () => console.log("🧠 Redis pronto para uso!"));
redisClient.on("error", (err) => console.error("❌ Erro Redis:", err.message));
redisClient.on("end", () => console.warn("⚠️ Conexão Redis encerrada."));

export async function startRedis() {
    try {
        await redisClient.connect();
        console.log("🚀 Redis conectado e validado!");
        await redisClient.set("redis_health_check", "ok", { EX: 5 });
        const test = await redisClient.get("redis_health_check");
        console.log("💚 Health Check Redis:", test === "ok" ? "OK" : "Falhou");
    } catch (err) {
        console.error("❌ Falha ao conectar Redis:", err.message);
    }
}

export default redisClient;
