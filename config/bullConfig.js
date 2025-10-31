// config/bullConfig.js
import { Queue, QueueEvents } from "bullmq";
import chalk from "chalk";
import IORedis from "ioredis";

// ======================================================
// 🧠 Conexão Redis unificada (BullMQ + Bull Board)
// ======================================================
const redisConnection = new IORedis({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
  password: process.env.REDIS_PASSWORD,
  maxRetriesPerRequest: null, // ✅ obrigatório
  enableReadyCheck: false,
});

redisConnection.on("connect", () => console.log(chalk.green("✅ Redis conectado (BullMQ/Bull Board)")));
redisConnection.on("ready", () => console.log(chalk.cyan("🧩 Redis pronto para BullMQ!")));
redisConnection.on("error", (err) => console.error(chalk.red("💥 Erro Redis BullMQ:"), err.message));

// ======================================================
// 🎯 Instâncias globais da fila Follow-up
// ======================================================
export const followupQueue = new Queue("followupQueue", { connection: redisConnection });
export const followupEvents = new QueueEvents("followupQueue", { connection: redisConnection });

// Exporta a conexão única
export { redisConnection };
