/**
 * Concorrência REAL do cadastro de interesse: POSTs simultâneos (conexões HTTP e operações Mongo de fato
 * paralelas) da mesma pessoa + convênio devem resultar em exatamente UM cadastro ativo.
 */
import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WAITLIST_ACTIVE_STATUS, WAITLIST_CONSENT_VERSIONS } from '../../constants/convenioWaitlist.js';
import ConvenioWaitlist, { ensureConvenioWaitlistIndexes } from '../../models/ConvenioWaitlist.js';
import { createConvenioWaitlistRouter } from '../../routes/convenioWaitlist.js';

let mongod;
let app;

const body = (overrides = {}) => ({
    nome: 'Maria da Silva',
    telefone: '(62) 99201-3573',
    convenio: 'geap',
    especialidade: 'Terapia Ocupacional',
    consentimento: { aceito: true, versao: WAITLIST_CONSENT_VERSIONS[0] },
    ...overrides,
});

const post = (payload) => request(app).post('/api/convenio-waitlist').send(payload);

const activeCount = (phone, convenio) =>
    ConvenioWaitlist.countDocuments({ phone, convenio, status: { $in: WAITLIST_ACTIVE_STATUS } });

beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    await ensureConvenioWaitlistIndexes();

    app = express();
    app.use(express.json());
    app.use('/api/convenio-waitlist', createConvenioWaitlistRouter({ submitLimit: { max: 100000 } }));
}, 60000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
});

beforeEach(async () => {
    await ConvenioWaitlist.deleteMany({});
});

describe('deduplicação atômica de telefone + convênio', () => {
    it('dois POSTs simultâneos criam exatamente um cadastro ativo (um 201 e um 200)', async () => {
        const [a, b] = await Promise.all([post(body()), post(body())]);

        expect([a.status, b.status].sort()).toEqual([200, 201]);
        expect([a.body.duplicate, b.body.duplicate].sort()).toEqual([false, true]);
        expect(a.body.id).toBe(b.body.id);
        expect(await activeCount('5562992013573', 'geap')).toBe(1);
        expect(await ConvenioWaitlist.countDocuments()).toBe(1);

        const doc = await ConvenioWaitlist.findById(a.body.id).lean();
        expect(doc.requestCount).toBe(2);
        expect(doc.submissions).toHaveLength(2);
    });

    it('repetido em 30 rodadas (telefones diferentes) nunca gera duplicata', async () => {
        for (let round = 0; round < 30; round += 1) {
            const telefone = `(62) 98${String(round).padStart(3, '0')}-${String(1000 + round)}`;
            const [a, b] = await Promise.all([post(body({ telefone })), post(body({ telefone }))]);
            expect([a.status, b.status].sort()).toEqual([200, 201]);
        }
        const groups = await ConvenioWaitlist.aggregate([
            { $group: { _id: { phone: '$phone', convenio: '$convenio' }, n: { $sum: 1 } } },
            { $match: { n: { $gt: 1 } } },
        ]);
        expect(groups).toEqual([]);
        expect(await ConvenioWaitlist.countDocuments()).toBe(30);
    }, 60000);

    it('10 POSTs simultâneos: um único cadastro, um 201, nove 200, contagem e histórico consistentes', async () => {
        const responses = await Promise.all(Array.from({ length: 10 }, () => post(body())));

        expect(responses.filter((res) => res.status === 201)).toHaveLength(1);
        expect(responses.filter((res) => res.status === 200)).toHaveLength(9);
        expect(new Set(responses.map((res) => res.body.id)).size).toBe(1);
        expect(await activeCount('5562992013573', 'geap')).toBe(1);

        const doc = await ConvenioWaitlist.findOne().lean();
        expect(doc.requestCount).toBe(10);
        expect(doc.submissions).toHaveLength(10);
    });

    it('simultâneos em convênios diferentes NÃO se bloqueiam: um cadastro ativo por convênio', async () => {
        const responses = await Promise.all(
            ['geap', 'ipasgo', 'bradesco'].map((convenio) => post(body({ convenio }))),
        );
        expect(responses.map((res) => res.status)).toEqual([201, 201, 201]);
        expect(await ConvenioWaitlist.countDocuments()).toBe(3);
    });

    it('sem consentimento nenhum dos simultâneos grava (nenhum documento parcial)', async () => {
        const responses = await Promise.all(
            Array.from({ length: 5 }, () => post(body({ consentimento: { aceito: false, versao: WAITLIST_CONSENT_VERSIONS[0] } }))),
        );
        expect(responses.every((res) => res.status === 400)).toBe(true);
        expect(await ConvenioWaitlist.countDocuments()).toBe(0);
    });
});
