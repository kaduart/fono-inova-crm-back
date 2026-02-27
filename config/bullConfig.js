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

// 🎬 NOVO: Fila de geração de vídeos (HeyGen + FFmpeg)
export const videoGenerationQueue = new Queue("video-generation", { 
    connection: redisConnection,
    defaultJobOptions: {
        attempts: 2,
        backoff: {
            type: 'exponential',
            delay: 30000  // 30s entre tentativas
        },
        removeOnComplete: 50,  // Mantém últimos 50 jobs
        removeOnFail: 20       // Mantém últimos 20 falhos
    }
});

export const videoGenerationEvents = new QueueEvents("video-generation", { 
    connection: redisConnection 
});

// 📝 NOVO: Fila de geração de posts (GMB, Instagram, Facebook)
export const postGenerationQueue = new Queue("post-generation", { 
    connection: redisConnection,
    defaultJobOptions: {
        attempts: 2,
        backoff: {
            type: 'exponential',
            delay: 15000  // 15s entre tentativas
        },
        removeOnComplete: 100,
        removeOnFail: 50
    }
});

export const postGenerationEvents = new QueueEvents("post-generation", { 
    connection: redisConnection 
});
