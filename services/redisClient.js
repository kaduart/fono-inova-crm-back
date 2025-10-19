import { createClient } from "redis";

// ===================================================
// ⚙️ CONFIGURAÇÃO SIMPLIFICADA — SOMENTE LOCAL
// ===================================================
const envMode = process.env.NODE_ENV || "development";

console.log(`🌍 Modo detectado: ${envMode}`);
console.log("🚀 Conectando ao Redis Local (VPS/EasyPanel)...");

const redisClient = createClient({
    socket: {
        host: process.env.REDIS_HOST || "127.0.0.1",
        port: process.env.REDIS_PORT || 6379,
        reconnectStrategy: (retries) => {
            console.warn(`🔁 Tentando reconectar ao Redis (tentativa ${retries})...`);
            return Math.min(retries * 1000, 15000);
        },
        keepAlive: 15000,
        connectTimeout: 15000,
    },
    password: process.env.REDIS_PASSWORD,
});

// ===================================================
// 🧠 EVENTOS E LOGS
// ===================================================
redisClient.on("connect", () => console.log("✅ Redis conectado (Local)"));
redisClient.on("ready", () => console.log("🧠 Redis pronto para uso!"));
redisClient.on("end", () => console.warn("⚠️ Conexão Redis encerrada."));
redisClient.on("reconnecting", () => console.log("🔁 Tentando reconexão ao Redis..."));
redisClient.on("error", (err) => console.error("❌ Erro Redis:", err.message));

// ===================================================
// 🚀 INICIALIZAÇÃO + HEALTH CHECK
// ===================================================
export async function startRedis() {
    try {
        await redisClient.connect();
        console.log("🚀 Redis conectado e validado!");

        await redisClient.set("redis_health_check", "ok", { EX: 10 });
        const test = await redisClient.get("redis_health_check");
        console.log(`💚 Health Check Redis: ${test === "ok" ? "OK" : "Falhou"}`);

        // 🔄 Ping a cada 5 minutos
        setInterval(async () => {
            try {
                await redisClient.ping();
            } catch (err) {
                console.warn("⚠️ Redis ping falhou:", err.message);
            }
        }, 300000);
    } catch (err) {
        console.error("❌ Falha ao conectar Redis:", err.message);
    }
}

// ===================================================
// 🧩 REUTILIZAÇÃO GLOBAL
// ===================================================
export function getRedis() {
    return redisClient;
}

export default redisClient;
