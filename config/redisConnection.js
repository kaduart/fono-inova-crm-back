// config/redisConnection.js
import chalk from "chalk";
import IORedis from "ioredis";

let redisConnection;

try {
  const redisUrl = process.env.REDIS_URL;
  const isUpstash = redisUrl?.includes("upstash");

  if (isUpstash && redisUrl) {
    redisConnection = new IORedis(redisUrl, {
      tls: {},
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  } else {
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
