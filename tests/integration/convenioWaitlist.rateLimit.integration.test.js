/**
 * Rate limit do cadastro público ATRÁS DO PROXY (Cloudflare/Render).
 *
 * O supertest conecta de 127.0.0.1 — esse é o "proxy". O cabeçalho X-Forwarded-For simula o que o proxy
 * anexa: a lista termina com o IP do visitante que o proxy enxergou; o que vem à esquerda pode ter sido
 * forjado pelo cliente. Com `trust proxy` = 1 o Express usa apenas a entrada mais à direita.
 *
 * Os POSTs usam payload inválido de propósito (400 antes de tocar no banco): o limitador conta a
 * requisição mesmo assim, então não precisa de Mongo.
 */
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureTrustProxy } from '../../config/trustProxy.js';
import { createConvenioWaitlistRouter } from '../../routes/convenioWaitlist.js';

const LIMIT = 3;

const buildApp = (trustProxyHops) => {
    const app = express();
    if (trustProxyHops !== undefined) configureTrustProxy(app, trustProxyHops);
    app.use(express.json());
    app.use('/api/convenio-waitlist', createConvenioWaitlistRouter({ submitLimit: { max: LIMIT } }));
    return app;
};

// visitante real = última entrada do X-Forwarded-For; `spoof` = lixo forjado pelo cliente à esquerda
const hit = (app, realIp, spoof) =>
    request(app)
        .post('/api/convenio-waitlist')
        .set('X-Forwarded-For', spoof ? `${spoof}, ${realIp}` : realIp)
        .send({});

const exhaust = async (app, realIp) => {
    for (let i = 0; i < LIMIT; i += 1) {
        expect((await hit(app, realIp)).status).toBe(400); // passou pelo limitador e falhou na validação
    }
};

describe('rate limit por visitante com trust proxy configurado', () => {
    beforeEach(() => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('visitantes diferentes NÃO compartilham o limite', async () => {
        const app = buildApp('1');

        await exhaust(app, '203.0.113.10'); // visitante A gasta o limite
        expect((await hit(app, '203.0.113.10')).status).toBe(429);

        // visitante B (outro IP real) continua com o limite inteiro
        expect((await hit(app, '198.51.100.7')).status).toBe(400);
        await exhaust(app, '198.51.100.8');
        expect((await hit(app, '198.51.100.8')).status).toBe(429);

        // e A continua bloqueado sem afetar quem ainda não usou
        expect((await hit(app, '203.0.113.10')).status).toBe(429);
        expect((await hit(app, '192.0.2.55')).status).toBe(400);
    });

    it('forjar entradas à esquerda do X-Forwarded-For NÃO reinicia o limite do mesmo visitante', async () => {
        const app = buildApp('1');
        await exhaust(app, '203.0.113.10');

        for (const spoof of ['1.1.1.1', '2.2.2.2', '8.8.8.8, 9.9.9.9', '203.0.113.99']) {
            expect((await hit(app, '203.0.113.10', spoof)).status).toBe(429);
        }
    });

    it('um visitante forjando o IP de outro não consome o limite do IP forjado', async () => {
        const app = buildApp('1');
        // atacante (IP real 203.0.113.10) diz ser 198.51.100.7 à esquerda várias vezes
        for (let i = 0; i < LIMIT; i += 1) {
            await hit(app, '203.0.113.10', '198.51.100.7');
        }
        expect((await hit(app, '203.0.113.10', '198.51.100.7')).status).toBe(429);
        // a vítima (198.51.100.7 de verdade) está intacta
        expect((await hit(app, '198.51.100.7')).status).toBe(400);
    });

    it('com 2 saltos (ex.: Cloudflare + balanceador) o visitante é a penúltima entrada, também isolado', async () => {
        const app = buildApp('2');
        const viaTwoProxies = (client) =>
            request(app).post('/api/convenio-waitlist').set('X-Forwarded-For', `${client}, 172.70.0.1`).send({});

        for (let i = 0; i < LIMIT; i += 1) await viaTwoProxies('203.0.113.10');
        expect((await viaTwoProxies('203.0.113.10')).status).toBe(429);
        expect((await viaTwoProxies('198.51.100.7')).status).toBe(400);
    });
});

describe('controle negativo: sem trust proxy o limite seria compartilhado (por isso a configuração é obrigatória)', () => {
    it('todos os visitantes caem no IP do proxy e um bloqueia os outros', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {}); // express-rate-limit avisa do X-Forwarded-For sem trust proxy

        const app = buildApp(undefined);
        await exhaust(app, '203.0.113.10');
        // outro visitante real, mas o limitador enxerga só o IP do proxy → 429 indevido
        expect((await hit(app, '198.51.100.7')).status).toBe(429);
        vi.restoreAllMocks();
    });
});
