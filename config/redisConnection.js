// config/redisConnection.js - OTIMIZADO PARA REDIS COM LIMITE DE CONEXÕES
import chalk from "chalk";
import IORedis from "ioredis";

const REDIS_RETRY_STRATEGY = (times) => {
  const delay = Math.min(times * 100, 3000);
  console.log(`🔄 Redis retry ${times}, delay ${delay}ms`);
  return delay;
};

const REDIS_RECONNECT_ON_ERROR = (err) => {
  const targetErrors = ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE'];
  const shouldReconnect = targetErrors.some(e => err.message.includes(e));
  if (shouldReconnect) {
    console.log('🔄 Redis reconnect on error:', err.message);
  }
  return shouldReconnect;
};

// 🎯 Opções OTIMIZADAS para limitar conexões
const commonOptions = {
  maxRetriesPerRequest: 3,
  enableReadyCheck: false,
  connectTimeout: 10000,
  lazyConnect: true,
  retryStrategy: REDIS_RETRY_STRATEGY,
  reconnectOnError: REDIS_RECONNECT_ON_ERROR,
  keepAlive: 30000,
  // 🔥 IMPORTANTE: Limitar conexões no pool
  maxSockets: 5,
  maxFreeSockets: 2,
};

// 🎯 Opções para BullMQ (usa a mesma conexão, mas com maxRetriesPerRequest: null)
const bullMqOptions = {
  ...commonOptions,
  maxRetriesPerRequest: null, // BullMQ exige isso
};

let redisConnection;
let bullMqConnection;

try {
  const redisUrl = process.env.REDIS_URL;

  if (redisUrl) {
    console.log("🚀 IORedis conectando via REDIS_URL...");
    
    // 🔥 USA UMA ÚNICA CONEXÃO para ambos (economiza conexões)
    redisConnection = new IORedis(redisUrl, {
      ...commonOptions,
      ...(redisUrl.startsWith('rediss://') ? { tls: {} } : {}),
    });
    
    // Reutiliza a mesma instância para BullMQ (não cria nova conexão)
    bullMqConnection = redisConnection;
    
    console.log("✅ Modo econômico: Uma conexão Redis para todos");
  } else {
    console.log("🚀 IORedis conectando via HOST/PORT local...");
    
    const localConfig = {
      host: process.env.REDIS_HOST || "127.0.0.1",
      port: Number(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
    };
    
    redisConnection = new IORedis({ ...localConfig, ...commonOptions });
    bullMqConnection = redisConnection; // Mesma conexão
  }

  // 🛡️ Eventos de conexão
  redisConnection.on('connect', () => {
    console.log('✅ Redis connected');
  });

  redisConnection.on('ready', () => {
    console.log('✅ Redis ready');
  });

  redisConnection.on('error', (err) => {
    console.error(chalk.red('❌ Redis error:'), err.message);
  });

  redisConnection.on('reconnecting', () => {
    console.log('🔄 Redis reconnecting...');
  });

} catch (err) {
  console.error(chalk.red("❌ Falha ao conectar Redis:"), err.message);
  redisConnection = null;
  bullMqConnection = null;
}

// 🛡️ Wrapper seguro
export const safeRedis = {
  async get(key) {
    if (!redisConnection) return null;
    try {
      return await redisConnection.get(key);
    } catch (err) {
      console.error('Redis get error:', err.message);
      return null;
    }
  },
  async set(key, value, ...args) {
    if (!redisConnection) return null;
    try {
      return await redisConnection.set(key, value, ...args);
    } catch (err) {
      console.error('Redis set error:', err.message);
      return null;
    }
  },
  async del(key) {
    if (!redisConnection) return null;
    try {
      return await redisConnection.del(key);
    } catch (err) {
      console.error('Redis del error:', err.message);
      return null;
    }
  }
};

export { redisConnection, bullMqConnection };
