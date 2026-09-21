import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { configureTrustProxy, resolveTrustProxy } from '../../config/trustProxy.js';

describe('resolveTrustProxy', () => {
    it('usa 1 salto por padrão (env ausente ou vazia)', () => {
        expect(resolveTrustProxy(undefined)).toBe(1);
        expect(resolveTrustProxy('')).toBe(1);
        expect(resolveTrustProxy('   ')).toBe(1);
    });

    it('aceita número inteiro de saltos entre 0 e 5', () => {
        expect(resolveTrustProxy('0')).toBe(0);
        expect(resolveTrustProxy('2')).toBe(2);
        expect(resolveTrustProxy(3)).toBe(3);
    });

    it('nunca devolve true nem valores inválidos (evita confiar em qualquer X-Forwarded-For)', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        for (const invalid of ['true', 'abc', '-1', '1.5', '99', 'loopback']) {
            expect(resolveTrustProxy(invalid)).toBe(1);
        }
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});

describe('configureTrustProxy', () => {
    it("define 'trust proxy' no app com o número de saltos resolvido", () => {
        const settings = {};
        const app = { set: (key, value) => { settings[key] = value; } };
        expect(configureTrustProxy(app, '2')).toBe(2);
        expect(settings['trust proxy']).toBe(2);
    });
});

describe('server.js', () => {
    it('aplica configureTrustProxy(app) antes de montar as rotas', () => {
        const source = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
        const configured = source.indexOf('configureTrustProxy(app)');
        const firstRoute = source.indexOf("app.use('/api/leads'");
        expect(configured).toBeGreaterThan(-1);
        expect(firstRoute).toBeGreaterThan(-1);
        expect(configured).toBeLessThan(firstRoute);
    });

    it('garante o índice único da lista de interesse depois de conectar ao Mongo (autoIndex é off em produção)', () => {
        const source = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
        const connected = source.indexOf('MongoDB conectado');
        const ensured = source.indexOf('ensureConvenioWaitlistIndexes()');
        expect(connected).toBeGreaterThan(-1);
        expect(ensured).toBeGreaterThan(connected);
    });
});
