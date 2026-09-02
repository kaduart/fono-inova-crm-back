/**
 * Testes de regressão para calculatePackageState/rebuildPackageFromSource.
 *
 * Cobre o incidente do Victor Gabriel (2026-09-02): o pacote tinha 3 sessões
 * realmente completadas e 1 ainda 'scheduled' (data futura), mas o banco
 * mostrava sessionsDone=4/status='finished' — bloqueando "Finalizar
 * Atendimento" com PACKAGE_EXHAUSTED mesmo sobrando 1 sessão legítima.
 *
 * A causa raiz exata (qual execução gravou o dado errado) não pôde ser
 * confirmada — o repositório não tem histórico git para checar qual versão
 * do código rodou em 2026-07-30. A lógica atual de calculatePackageState já
 * está correta (verificado manualmente contra o dado real de produção); este
 * teste existe para travar essa correção como invariante e pegar qualquer
 * regressão futura antes que volte a acontecer.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { calculatePackageState, rebuildPackageFromSource, auditPackage } from '../rebuildPackageFromSource.js';

let mongoServer;
let db;

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    db = mongoose.connection.db;
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
});

beforeEach(async () => {
    await db.collection('packages').deleteMany({});
    await db.collection('sessions').deleteMany({});
    await db.collection('appointments').deleteMany({});
    await db.collection('payments').deleteMany({});
});

function basePackageDoc(overrides = {}) {
    return {
        durationMonths: 1,
        sessionsPerWeek: 1,
        patient: new mongoose.Types.ObjectId(),
        doctor: new mongoose.Types.ObjectId(),
        sessionType: 'fonoaudiologia',
        sessionValue: 160,
        totalSessions: 4,
        totalValue: 640,
        date: new Date('2026-07-22'),
        status: 'active',
        type: 'therapy',
        ...overrides
    };
}

describe('calculatePackageState — invariante de pacote com sessão ativa pendente', () => {
    it('não marca finished nem consome a última sessão enquanto ela ainda está scheduled (regressão caso Victor)', async () => {
        const packageId = new mongoose.Types.ObjectId();
        await db.collection('packages').insertOne({ _id: packageId, ...basePackageDoc() });

        const sessionIds = [1, 2, 3, 4].map(() => new mongoose.Types.ObjectId());
        await db.collection('sessions').insertMany([
            { _id: sessionIds[0], package: packageId, status: 'completed', date: new Date('2026-07-22') },
            { _id: sessionIds[1], package: packageId, status: 'completed', date: new Date('2026-08-05') },
            { _id: sessionIds[2], package: packageId, status: 'completed', date: new Date('2026-08-19') },
            // Última sessão do pacote: ainda não aconteceu.
            { _id: sessionIds[3], package: packageId, status: 'scheduled', date: new Date('2026-09-02') },
        ]);

        const state = await calculatePackageState(packageId);

        expect(state.sessionsDone).toBe(3);
        expect(state.sessionsRemaining).toBe(1);
        expect(state.status).not.toBe('finished');
        expect(state.status).toBe('active');
    });

    it('marca finished quando todas as sessões realmente estão completed', async () => {
        const packageId = new mongoose.Types.ObjectId();
        await db.collection('packages').insertOne({ _id: packageId, ...basePackageDoc() });

        const sessionIds = [1, 2, 3, 4].map(() => new mongoose.Types.ObjectId());
        await db.collection('sessions').insertMany(
            sessionIds.map((id, i) => ({
                _id: id,
                package: packageId,
                status: 'completed',
                date: new Date(`2026-0${7 + i}-01`)
            }))
        );

        const state = await calculatePackageState(packageId);

        expect(state.sessionsDone).toBe(4);
        expect(state.sessionsRemaining).toBe(0);
        expect(state.status).toBe('finished');
    });

    it('rebuildPackageFromSource persiste a correção sem tocar em totalPaid/financialStatus quando o pagamento já está OK', async () => {
        const packageId = new mongoose.Types.ObjectId();
        // Estado corrompido: sessionsDone/status como se estivesse tudo pago e feito,
        // igual ao dado real encontrado em produção.
        await db.collection('packages').insertOne({
            _id: packageId,
            ...basePackageDoc({ sessionsDone: 4, status: 'finished', totalPaid: 640, consumedValue: 640 })
        });

        const sessionIds = [1, 2, 3, 4].map(() => new mongoose.Types.ObjectId());
        await db.collection('sessions').insertMany([
            { _id: sessionIds[0], package: packageId, status: 'completed', date: new Date('2026-07-22') },
            { _id: sessionIds[1], package: packageId, status: 'completed', date: new Date('2026-08-05') },
            { _id: sessionIds[2], package: packageId, status: 'completed', date: new Date('2026-08-19') },
            { _id: sessionIds[3], package: packageId, status: 'scheduled', date: new Date('2026-09-02') },
        ]);
        await db.collection('payments').insertOne({
            package: packageId, status: 'paid', amount: 640
        });

        const before = await auditPackage(packageId);
        expect(before.hasIssues).toBe(true);
        expect(before.current.sessionsDone).toBe(4);
        expect(before.rebuilt.sessionsDone).toBe(3);

        const result = await rebuildPackageFromSource(packageId);

        expect(result.sessionsDone).toBe(3);
        expect(result.status).toBe('active');
        expect(result.totalPaid).toBe(640);
        expect(result.financialStatus).toBe('paid');
    });
});
