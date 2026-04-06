// Proxy para compatibilidade - usa redisConnection.js (ioredis)
export { redisConnection as default, redisConnection, bullMqConnection, safeRedis } from '../config/redisConnection.js';

// Compatibilidade: funções que o código antigo espera
export const getRedis = () => redisConnection;
export const startRedis = async () => {
    await redisConnection.ping().catch(() => {});
};
