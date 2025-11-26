// config/bullConfig.js
import { Queue, QueueEvents } from "bullmq";
import chalk from "chalk";
import { redisConnection } from "./redisConnection.js";

export const followupQueue = new Queue("followupQueue", { connection: redisConnection });
export const followupEvents = new QueueEvents("followupQueue", { connection: redisConnection });
