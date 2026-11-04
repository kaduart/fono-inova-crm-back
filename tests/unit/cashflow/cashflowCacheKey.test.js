// Caso André Cunha Ferraz (04/11/2026): editar a data de um pagamento não tirava
// o item do Recebimentos do dia antigo. O get/set do cache gravava a chave SEM o
// prefixo `cashflow:v2:` e o clearCashflowCache apagava a chave COM prefixo.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map();
vi.mock('../../../config/redisConnection.js', () => ({
    safeRedis: {
        get: async (k) => store.get(k) ?? null,
        set: async (k, v) => { store.set(k, v); return 'OK'; },
        del: async (...keys) => { let n = 0; for (const k of keys) if (store.delete(k)) n++; return n; },
        scan: async (_c, _m, pattern) => {
            const re = new RegExp('^' + pattern.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
            return ['0', [...store.keys()].filter(k => re.test(k))];
        },
    },
    redisConnection: null,
    bullMqConnection: null,
}));

const { clearCashflowCache, __cashflowRedisKeyForDate } = await import('../../../routes/cashflow.v2.js');

describe('cache do cashflow: chave gravada = chave invalidada', () => {
    beforeEach(() => store.clear());

    it('a chave do dia usa o prefixo cashflow:v2:', () => {
        expect(__cashflowRedisKeyForDate('2026-11-05')).toBe('cashflow:v2:2026-11-05___');
    });

    it('clearCashflowCache(data) apaga a chave do dia (com prefixo) e a legada sem prefixo', async () => {
        store.set(__cashflowRedisKeyForDate('2026-11-05'), '{}');
        store.set('2026-11-05___', '{}'); // legado, gravado antes do fix
        store.set(__cashflowRedisKeyForDate('2026-11-06'), '{}');
        store.set('date_2026-11-05_2026-11-05___', '{}'); // cache de outra rota: não pode sumir

        await clearCashflowCache('2026-11-05');

        expect(store.has('cashflow:v2:2026-11-05___')).toBe(false);
        expect(store.has('2026-11-05___')).toBe(false);
        expect(store.has('cashflow:v2:2026-11-06___')).toBe(true);
        expect(store.has('date_2026-11-05_2026-11-05___')).toBe(true);
    });
});
