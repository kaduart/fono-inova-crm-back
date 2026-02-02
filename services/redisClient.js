import { createClient } from "redis";

// ===================================================
// ⚙️ CONFIGURAÇÃO DO CLIENTE REDIS
// Suporta REDIS_URL (Render/Upstash) ou REDIS_HOST+REDIS_PORT (local)
// ===================================================
const envMode = process.env.NODE_ENV || "development";
const redisUrl = process.env.REDIS_URL;

console.log(`🌍 Modo detectado: ${envMode}`);
console.log(`🔍 REDIS_URL existe? ${redisUrl ? 'SIM' : 'NÃO'}`);
if (redisUrl) {
    console.log(`🔗 REDIS_URL (mascarada): ${redisUrl.replace(/\/\/.*@/, '//***@')}`);
}

let redisConfig;

if (redisUrl) {
    // Usar REDIS_URL (Render Native, Upstash, etc)
    console.log("🚀 Conectando ao Redis via REDIS_URL...");
    redisConfig = {
        url: redisUrl,
        socket: {
            reconnectStrategy: (retries) => {
                console.warn(`🔁 Tentando reconectar ao Redis (tentativa ${retries})...`);
                return Math.min(retries * 1000, 15000);
            },
            keepAlive: 15000,
            connectTimeout: 30000, // Aumentado para 30s
        },
    };

    // Se for Upstash ou qualquer rediss://, adicionar TLS
    if (redisUrl.startsWith('rediss://')) {
        console.log("🔒 TLS ativado (rediss://)");
        redisConfig.socket.tls = true;
        redisConfig.socket.rejectUnauthorized = false; // Necessário para alguns certs
    }
} else {
    // Usar REDIS_HOST + REDIS_PORT (local/VPS)
    const host = process.env.REDIS_HOST || "127.0.0.1";
    const port = Number(process.env.REDIS_PORT) || 6379;
    console.log(`🚀 Conectando ao Redis Local: ${host}:${port}`);
    redisConfig = {
        socket: {
            host: host,
            port: port,
            reconnectStrategy: (retries) => {
                console.warn(`🔁 Tentando reconectar ao Redis (tentativa ${retries})...`);
                return Math.min(retries * 1000, 15000);
            },
            keepAlive: 15000,
            connectTimeout: 15000,
        },
        password: process.env.REDIS_PASSWORD || undefined,
    };
}

const redisClient = createClient(redisConfig);

// Eventos de erro e reconexão
redisClient.on('error', (err) => {
    console.error('⚠️ Redis Client Error:', err.message);
});

redisClient.on('connect', () => {
    console.log('✅ Redis Client conectado!');
});

redisClient.on('reconnecting', () => {
    console.log('🔄 Redis Client reconectando...');
});

// ===================================================
// 🚀 INICIALIZAÇÃO + HEALTH CHECK
// ===================================================
export async function startRedis() {
    try {
        console.log("🔄 Iniciando conexão Redis...");
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
        console.error("Stack:", err.stack);
        // Não lançar erro para não matar o processo, mas logar visivelmente
    }
}

// ===================================================
// 🧩 REUTILIZAÇÃO GLOBAL
// ===================================================
export function getRedis() {
    return redisClient;
}

export default redisClient;