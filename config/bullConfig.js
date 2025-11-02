// config/bullConfig.js
import { Queue, QueueEvents } from "bullmq";
import chalk from "chalk";
import { redisConnection } from "./redisConnection.js";

redisConnection.on("connect", () => console.log(chalk.green("✅ Redis conectado")));
redisConnection.on("ready", () => console.log(chalk.cyan("🧩 Redis pronto")));

export const followupQueue = new Queue("followupQueue", { connection: redisConnection });
export const followupEvents = new QueueEvents("followupQueue", { connection: redisConnection });
