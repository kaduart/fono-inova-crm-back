// utils/redisLock.js - Lock distribuído com Redis (ioredis)
import { redisConnection } from '../config/redisConnection.js';

const DEFAULT_TTL = 30;

export async function acquireLock(resource, ttl = DEFAULT_TTL) {
  const token = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const key = `lock:${resource}`;
  const result = await redisConnection.set(key, token, 'NX', 'EX', ttl);
  return result === 'OK' ? token : null;
}

export async function releaseLock(resource, token) {
  const key = `lock:${resource}`;
  const current = await redisConnection.get(key);
  if (current === token) {
    await redisConnection.del(key);
    return true;
  }
  return false;
}

export async function withLock(resource, fn, options = {}) {
  const { ttl = DEFAULT_TTL } = options;
  const token = await acquireLock(resource, ttl);
  if (!token) throw new Error(`LOCK_FAILED: ${resource}`);
  try {
    return await fn();
  } finally {
    await releaseLock(resource, token);
  }
}
