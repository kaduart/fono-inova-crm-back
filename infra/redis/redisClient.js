// Proxy para compatibilidade com código que espera infra/redis/redisClient.js
export { getRedis as getRedisConnection, redisConnection as default } from '../../services/redisClient.js';
