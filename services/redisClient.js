import { createClient } from "redis";

// ===================================================
// ⚙️ CONFIGURAÇÃO DO CLIENTE REDIS
// Suporta REDIS_URL (Render/Upstash) ou REDIS_HOST+REDIS_PORT (local)
// ===================================================
const envMode = process.env.NODE_ENV || "development";
const redisUrl = process.env.REDIS_URL;

console.log(`🌍 Modo detectado: ${envMode}`);

let redisConfig;

if (redisUrl) {
    // Usar REDIS_URL (Render, Upstash, etc)
    console.log("🚀 Conectando ao Redis via REDIS_URL...");
    redisConfig = {
        url: redisUrl,
        socket: {
            reconnectStrategy: (retries) => {
                console.warn(`🔁 Tentando reconectar ao Redis (tentativa ${retries})...`);
                return Math.min(retries * 1000, 15000);
            },
            keepAlive: 15000,
            connectTimeout: 15000,
        },
    };
    
    // Se for Upstash (URL contém 'upstash'), adicionar TLS
    if (redisUrl.includes('upstash') || redisUrl.includes('rediss://')) {
        redisConfig.socket.tls = true;
    }
} else {
    // Usar REDIS_HOST + REDIS_PORT (local/VPS)
    console.log("🚀 Conectando ao Redis Local (VPS/EasyPanel)...");
    redisConfig = {
        socket: {
            host: process.env.REDIS_HOST || "127.0.0.1",
            port: Number(process.env.REDIS_PORT) || 6379,
            reconnectStrategy: (retries) => {
                console.warn(`🔁 Tentando reconectar ao Redis (tentativa ${retries})...`);
                return Math.min(retries * 1000, 15000);
            },
            keepAlive: 15000,
            connectTimeout: 15000,
        },
        password: process.env.REDIS_PASSWORD,
    };
}

const redisClient = createClient(redisConfig);

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
        // Não sair do processo, apenas logar o erro
        // para não quebrar o deploy no Render se o Redis não estiver disponível
    }
}

// ===================================================
// 🧩 REUTILIZAÇÃO GLOBAL
// ===================================================
export function getRedis() {
    return redisClient;
}

export default redisClient;
