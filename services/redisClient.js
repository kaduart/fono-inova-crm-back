// Proxy para compatibilidade - usa redisConnection.js (ioredis)
import { redisConnection, bullMqConnection, safeRedis } from '../config/redisConnection.js';

export { redisConnection as default, redisConnection, bullMqConnection, safeRedis };

// Compatibilidade: funções que o código antigo espera
export const getRedis = () => redisConnection;
export const startRedis = async () => {
    if (!redisConnection) return;
    await redisConnection.ping().catch(() => {});
};
