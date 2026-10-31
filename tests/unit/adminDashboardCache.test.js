// Auditoria do Dashboard admin (31/10/2026): B4 (arrays perdiam _cachedAt) e
// B5 (timeout rodava o builder duas vezes).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map();
vi.mock('../../services/redisClient.js', () => ({
  default: {
    isReady: true,
    get: vi.fn(async (k) => store.get(k) ?? null),
    setEx: vi.fn(async (k, _ttl, v) => { store.set(k, v); }),
    del: vi.fn(async (k) => { store.delete(k); }),
    keys: vi.fn(async () => [...store.keys()]),
  },
}));

const { dashboardCache } = await import('../../services/adminDashboardCacheService.js');
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('adminDashboardCacheService.getOrSet', () => {
  beforeEach(() => { store.clear(); });

  it('array em cache fresco NÃO dispara rebuild a cada HIT', async () => {
    const builder = vi.fn(async () => [{ a: 1 }, { a: 2 }]);
    const first = await dashboardCache.getOrSet('t:arr', builder, 120);
    await flush();
    const second = await dashboardCache.getOrSet('t:arr', builder, 120);
    await flush(); await flush();
    expect(Array.isArray(first)).toBe(true);
    expect(second).toEqual([{ a: 1 }, { a: 2 }]);
    expect(builder).toHaveBeenCalledTimes(1);
  });

  it('builder lento roda UMA vez, mesmo com chamadas simultâneas', async () => {
    let resolve;
    const builder = vi.fn(() => new Promise((r) => { resolve = r; }));
    const p1 = dashboardCache.getOrSet('t:slow', builder, 120);
    const p2 = dashboardCache.getOrSet('t:slow', builder, 120);
    await flush();
    resolve({ ok: true });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(builder).toHaveBeenCalledTimes(1);
  });
});
