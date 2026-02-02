// config/redisConnection.js
import chalk from "chalk";
import IORedis from "ioredis";

let redisConnection;

try {
  const redisUrl = process.env.REDIS_URL;
  const isUpstash = redisUrl?.includes("upstash");

  // NOVO: Verifica se tem REDIS_URL primeiro (independente de ser Upstash ou não)
  if (redisUrl) {
    console.log("🚀 Conectando ao Redis via REDIS_URL...");
    redisConnection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      // Só adiciona TLS se for Upstash (rediss://) ou TLS explícito
      ...(isUpstash || redisUrl.startsWith('rediss://') ? { tls: {} } : {}),
    });
  } else {
    // Só usa config local se NÃO tiver REDIS_URL
    console.log("🚀 Conectando ao Redis Local (VPS)...");
    redisConnection = new IORedis({
      host: process.env.REDIS_HOST || "127.0.0.1",
      port: Number(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      retryStrategy: (times) => Math.min(times * 500, 15000),
      reconnectOnError: () => true,
    });
  }
} catch (err) {
  console.error(chalk.red("❌ Falha ao conectar Redis:"), err.message);
  process.exit(1);
}

export { redisConnection };
