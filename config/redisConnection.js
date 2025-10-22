// config/redisConnection.js
import chalk from "chalk";
import IORedis from "ioredis";

let redisConnection;

try {
  const redisUrl = process.env.REDIS_URL;
  const isUpstash = redisUrl?.includes("upstash");
  const isLocal = !isUpstash;

  console.log(chalk.cyan(`🔎 REDIS_URL em runtime: ${redisUrl ? "[definida]" : "N/D"}`));
  console.log(chalk.cyan(`🔎 NODE_ENV: ${process.env.NODE_ENV || "development"}`));
  console.log(chalk[isUpstash ? "green" : "yellow"](`🌍 Modo detectado: ${isUpstash ? "Upstash (TLS)" : "Local Redis"}`));

  // ======================================================
  // 🚦 Intercepta ruído do ioredis (erro 127.0.0.1)
  // ======================================================
  const originalEmit = IORedis.prototype.emit;
  IORedis.prototype.emit = function (event, ...args) {
    if (event === "error" && args[0]?.message?.includes("127.0.0.1:6379")) return;
    return originalEmit.call(this, event, ...args);
  };

  // ======================================================
  // 🔌 Cria conexão conforme ambiente
  // ======================================================
  if (isUpstash && redisUrl) {
    redisConnection = new IORedis(redisUrl, {
      tls: {},
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  } else {
    redisConnection = new IORedis({
      host: process.env.REDIS_HOST || "127.0.0.1",
      port: process.env.REDIS_PORT || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      retryStrategy: (times) => Math.min(times * 500, 15000),
      reconnectOnError: () => true,
    });
  }

  // ======================================================
  // 🧠 Eventos
  // ======================================================
  redisConnection.on("connect", () =>
    console.log(chalk.green(`✅ Redis conectado (${isUpstash ? "Upstash" : "Local"})`))
  );
  redisConnection.on("ready", () => console.log(chalk.green("🧠 Redis pronto para uso!")));
  redisConnection.on("error", (err) => {
    if (!String(err).includes("127.0.0.1:6379"))
      console.error(chalk.red("💥 Redis erro crítico:"), err.message);
  });

} catch (err) {
  console.error(chalk.red("❌ Falha ao conectar Redis:"), err.message);
  process.exit(1);
}

export { redisConnection };
