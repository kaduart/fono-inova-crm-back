/**
 * Diagnóstico do pool do Mongo — a instrumentação é só log: não pode alterar resposta HTTP,
 * resultado de consulta, nem propagar erro para o driver/Express.
 * Banco: mongodb-memory-server (nunca o MONGO_URI).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let diag;

beforeAll(async () => {
    process.env.MONGO_POOL_SLOW_REQUEST_MS = '50';
    diag = await import('../../infrastructure/observability/mongoPoolDiagnostics.js');
});

afterAll(() => {
    delete process.env.MONGO_POOL_SLOW_REQUEST_MS;
});

beforeEach(() => diag._resetMongoPoolDiagnosticsForTests());
afterEach(() => vi.restoreAllMocks());

const poolLines = (spy) => spy.mock.calls.map(c => String(c[0])).filter(l => l.startsWith('[MongoPool]'));

function buildApp(withDiagnostics) {
    const app = express();
    if (withDiagnostics) app.use(diag.mongoPoolRequestMiddleware);
    const router = express.Router();
    router.get('/fast/:id', (req, res) => res.set('x-test', 'ok').status(201).json({ id: req.params.id, q: req.query.date }));
    router.get('/slow/:id', (req, res) => setTimeout(() => res.status(200).json({ id: req.params.id }), 80));
    app.use('/api/v2/cashflow', router);
    return app;
}

describe('mongoPoolRequestMiddleware — não altera o fluxo HTTP', () => {
    it('resposta idêntica (status, corpo, header) com e sem o middleware', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        const without = await request(buildApp(false)).get('/api/v2/cashflow/fast/abc?date=2026-09-25');
        const withDiag = await request(buildApp(true)).get('/api/v2/cashflow/fast/abc?date=2026-09-25');
        expect(withDiag.status).toBe(without.status);
        expect(withDiag.body).toEqual(without.body);
        expect(withDiag.headers['x-test']).toBe(without.headers['x-test']);
    });

    it('requisição rápida não gera log', async () => {
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await request(buildApp(true)).get('/api/v2/cashflow/fast/abc');
        expect(poolLines(spy)).toHaveLength(0);
    });

    it('requisição lenta gera 1 linha com o padrão da rota, sem id nem query string', async () => {
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const res = await request(buildApp(true)).get('/api/v2/cashflow/slow/PACIENTE123?date=2026-09-25');
        expect(res.status).toBe(200);
        await new Promise(r => setImmediate(r));
        const lines = poolLines(spy);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/^\[MongoPool\] requisição lenta GET \/api\/v2\/cashflow\/slow\/:id \d+ms status=200 \|/);
        expect(lines[0]).not.toContain('PACIENTE123');
        expect(lines[0]).not.toContain('2026-09-25');
    });

    it('erro no console.log não quebra a resposta', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => { throw new Error('log quebrado'); });
        const res = await request(buildApp(true)).get('/api/v2/cashflow/slow/x');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ id: 'x' });
    });
});

describe('attachMongoPoolDiagnostics — eventos do pool', () => {
    it('handler que falha não propaga erro para quem emite o evento (driver)', () => {
        vi.spyOn(console, 'log').mockImplementation(() => { throw new Error('log quebrado'); });
        const client = new EventEmitter();
        diag.attachMongoPoolDiagnostics(client);
        expect(() => {
            client.emit('connectionReady', { address: 'h:27017', connectionId: 1, durationMS: 10 });
            client.emit('connectionClosed', { address: 'h:27017', connectionId: 1, reason: 'error', error: new Error('x') });
            client.emit('connectionCheckOutFailed', undefined);
            client.emit('connectionPoolCleared', null);
        }).not.toThrow();
    });

    it('é idempotente: ligar 2x no mesmo client não duplica listeners', () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        const client = new EventEmitter();
        expect(diag.attachMongoPoolDiagnostics(client)).toBe(true);
        expect(diag.attachMongoPoolDiagnostics(client)).toBe(false);
        expect(client.listenerCount('connectionReady')).toBe(1);
    });

    it('checkout/checkin normais não geram log; criação e fechamento geram 1 linha cada, sem host', () => {
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const client = new EventEmitter();
        diag.attachMongoPoolDiagnostics(client);
        spy.mockClear();
        const address = 'ac-segredo-shard-00-01.xyz.mongodb.net:27017';
        client.emit('connectionReady', { address, connectionId: 7, durationMS: 1287.4 });
        for (let i = 0; i < 5; i++) {
            client.emit('connectionCheckOutStarted', { address });
            client.emit('connectionCheckedOut', { address, connectionId: 7, durationMS: 1 });
            client.emit('connectionCheckedIn', { address, connectionId: 7 });
        }
        client.emit('connectionClosed', { address, connectionId: 7, reason: 'idle' });
        const lines = poolLines(spy);
        expect(lines).toHaveLength(2);
        expect(lines[0]).toBe('[MongoPool] conexão criada no=n1 id=7 setupMs=1287 abertas=1 emUso=0 fila=0');
        expect(lines[1]).toMatch(/^\[MongoPool\] conexão fechada no=n1 id=7 motivo=idle vidaS=\d+ ociosaS=\d+ abertas=0$/);
        expect(lines.join('\n')).not.toContain('segredo');
        expect(diag.getMongoPoolSnapshot()).toMatchObject({ open: 0, inUse: 0, waiting: 0, created: 1, closed: 1 });
    });
});

describe('com banco real (memory-server) — consultas iguais com o diagnóstico ligado', () => {
    let mongoServer;
    let conn;

    beforeAll(async () => {
        mongoServer = await MongoMemoryServer.create();
        conn = await mongoose.createConnection(mongoServer.getUri()).asPromise();
        await conn.db.collection('itens').insertMany(Array.from({ length: 150 }, (_, i) => ({ n: i })));
    });

    afterAll(async () => {
        await conn?.close();
        await mongoServer?.stop();
    });

    it('mesmo resultado antes e depois de ligar; logs não expõem a URI', async () => {
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const before = await conn.db.collection('itens').find({}, { projection: { _id: 0 } }).sort({ n: 1 }).toArray();
        diag.attachMongoPoolDiagnostics(conn.getClient());
        const after = await Promise.all(Array.from({ length: 8 }, () =>
            conn.db.collection('itens').find({}, { projection: { _id: 0 } }).sort({ n: 1 }).toArray()));
        for (const r of after) expect(r).toEqual(before);
        const lines = poolLines(spy);
        const uriHost = new URL(mongoServer.getUri()).host;
        expect(lines.join('\n')).not.toContain(uriHost);
        // As 8 consultas simultâneas precisam de conexões novas além da que já existia
        expect(lines.some(l => l.startsWith('[MongoPool] conexão criada no=n1'))).toBe(true);
        expect(diag.getMongoPoolSnapshot().inUse).toBe(0);
    });
});
