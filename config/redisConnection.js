// src/config/redisConnection.js
export const redisConnection = process.env.REDIS_URL
    ? {
        url: process.env.REDIS_URL,
        tls: { rejectUnauthorized: false },
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
    }
    : {
        host: process.env.REDIS_HOST || "127.0.0.1",
        port: process.env.REDIS_PORT || 6379,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
    };
