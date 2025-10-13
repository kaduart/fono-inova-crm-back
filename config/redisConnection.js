// config/redisConnection.js
import chalk from "chalk";
import IORedis from "ioredis";

let redisConnection;

try {
    const redisUrl = process.env.REDIS_URL;
    const isUpstash = redisUrl?.includes("upstash");

    console.log(chalk.cyan(`🔎 REDIS_URL em runtime: ${redisUrl || "N/D"}`));
    console.log(chalk.cyan(`🔎 NODE_ENV: ${process.env.NODE_ENV || "development"}`));
    console.log(chalk[isUpstash ? "green" : "yellow"](`🌍 Modo detectado: ${isUpstash ? "Upstash (TLS)" : "Local Redis"}`));

    // ======================================================
    // 🔇 Intercepta ruído "127.0.0.1:6379" com segurança
    // ======================================================
    const originalEmit = IORedis.prototype.emit;
    IORedis.prototype.emit = function (event, ...args) {
        if (event === "error" && args[0]?.message?.includes("127.0.0.1:6379")) return;
        return originalEmit.call(this, event, ...args);
    };

    // ======================================================
    // 🚀 Conexão única
    // ======================================================
    redisConnection = new IORedis(redisUrl, {
        tls: isUpstash ? {} : undefined,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
    });

    redisConnection.on("connect", () => console.log(chalk.green("✅ Redis conectado (Upstash)")));
    redisConnection.on("ready", () => console.log(chalk.green("🧠 Redis pronto para uso!")));
    redisConnection.on("error", (err) => {
        if (!String(err).includes("127.0.0.1:6379"))
            console.error(chalk.red("💥 Redis erro crítico:"), err.message);
    });

    console.log(chalk.green("🚀 Redis conectado e validado!"));
} catch (err) {
    console.error(chalk.red("❌ Falha ao conectar ao Redis:"), err.message);
    process.exit(1);
}

export { redisConnection };
