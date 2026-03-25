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
        attempts: 1,           // sem retry automático — evita loop em caso de erro
        removeOnComplete: 50,
        removeOnFail: 20
    }
});

export const videoGenerationEvents = new QueueEvents("video-generation", {
    connection: redisConnection
});

// Fila de pós-produção manual (legendas, música, CTA) — separada da geração
export const posProducaoQueue = new Queue("pos-producao", {
    connection: redisConnection,
    defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 30000 },
        removeOnComplete: 50,
        removeOnFail: 20
    }
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
