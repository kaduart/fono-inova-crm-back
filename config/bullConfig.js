// config/bullConfig.js
import { Queue, QueueEvents } from "bullmq";
import chalk from "chalk";
import { redisConnection } from "./redisConnection.js";

// 🔄 Fila legada (mantida para compatibilidade)
export const followupQueue = new Queue("followupQueue", { connection: redisConnection });
export const followupEvents = new QueueEvents("followupQueue", { connection: redisConnection });

// 🆕 NOVO: Fila de follow-ups para leads mornos (tom acolhedor)
export const warmLeadFollowupQueue = new Queue("warm-lead-followup", { 
    connection: redisConnection,
    defaultJobOptions: {
        attempts: 3,
        backoff: {
            type: 'exponential',
            delay: 60000
        },
        removeOnComplete: 100, // Mantém últimos 100 jobs completos
        removeOnFail: 50       // Mantém últimos 50 jobs falhos
    }
});

export const warmLeadFollowupEvents = new QueueEvents("warm-lead-followup", { 
    connection: redisConnection 
});
