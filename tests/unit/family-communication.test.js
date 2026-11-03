/**
 * Resumo da sessão para a família (item 4), relatório mensal (item 3) e PEI (item 5) — 03/11/2026.
 * Mongo real em memória: o que importa é idempotência (travas atômicas + jobId fixo) e permissão.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const queueAdd = vi.fn(async () => ({ id: 'job' }));
vi.mock('../../config/bullConfig.js', () => ({ whatsappSendQueue: { add: (...a) => queueAdd(...a) } }));
vi.mock('../../infrastructure/events/eventPublisher.js', () => ({ publishEvent: vi.fn(), EventTypes: {} }));
vi.mock('../../middleware/amandaAuth.js', () => ({
    flexibleAuth: (req, _res, next) => {
        const [id, role] = String(req.headers['x-test-user'] || '').split(':');
        req.user = { id, role: role || 'doctor' };
        next();
    },
}));
vi.mock('../../services/generatePDF.js', () => ({
    generatePdfFromEvolution: vi.fn(),
    generatePdfFromTemplate: vi.fn(async () => Buffer.from('%PDF-1.4 teste')),
}));
vi.mock('../../models/Metric.js', () => ({ default: { find: vi.fn().mockResolvedValue([]) } }));
vi.mock('../../models/Patient.js', async () => {
    const m = (await import('mongoose')).default;
    return { default: m.models.Patient || m.model('Patient', new m.Schema({ fullName: String, phone: String, dateOfBirth: Date, status: String, isLead: Boolean })) };
});
vi.mock('../../models/Appointment.js', async () => {
    const m = (await import('mongoose')).default;
    return { default: m.models.Appointment || m.model('Appointment', new m.Schema({
        patient: m.Schema.Types.ObjectId, doctor: m.Schema.Types.ObjectId, date: Date, time: String, operationalStatus: String,
    })) };
});
vi.mock('../../models/Doctor.js', async () => {
    const m = (await import('mongoose')).default;
    return { default: m.models.Doctor || m.model('Doctor', new m.Schema({ fullName: String, specialty: String, phoneNumber: String, active: Boolean, licenseNumber: String })) };
});

let mongod, app, Evolution, Patient, Appointment, MonthlyReport, PeiPlan;
const oid = () => new mongoose.Types.ObjectId();
const DOC = oid().toString();
const OTHER = oid().toString();
const asDoc = (r) => r.set('x-test-user', `${DOC}:doctor`);
const asOther = (r) => r.set('x-test-user', `${OTHER}:doctor`);
const asSec = (r) => r.set('x-test-user', `${oid()}:secretary`);

beforeAll(async () => {
    mongod = await MongoMemoryServer.create({ instance: { storageEngine: 'wiredTiger' } });
    await mongoose.connect(mongod.getUri());
    Patient = (await import('../../models/Patient.js')).default;
    Appointment = (await import('../../models/Appointment.js')).default;
    await import('../../models/Doctor.js');
    Evolution = (await import('../../models/Evolution.js')).default;
    MonthlyReport = (await import('../../models/MonthlyReport.js')).default;
    PeiPlan = (await import('../../models/PeiPlan.js')).default;
    await Promise.all([Evolution.syncIndexes(), MonthlyReport.syncIndexes(), PeiPlan.syncIndexes()]);
    app = express();
    app.use(express.json());
    app.use('/v2/evolutions', (await import('../../routes/evolution.v2.js')).default);
    app.use('/v2/monthly-reports', (await import('../../routes/monthlyReport.v2.js')).default);
    app.use('/v2/pei', (await import('../../routes/pei.v2.js')).default);
}, 60000);

afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });

let patient;
const evo = (over = {}) => Evolution.create({
    patient: patient._id, doctor: DOC, date: new Date('2026-10-10T00:00:00Z'), specialty: 'fonoaudiologia',
    createdBy: DOC, status: 'finalized', evaluationAreas: [{ name: 'Linguagem expressiva', score: 5 }], ...over,
});

beforeEach(async () => {
    queueAdd.mockClear();
    queueAdd.mockImplementation(async () => ({ id: 'job' }));
    await Promise.all([Evolution.deleteMany({}), Patient.deleteMany({}), Appointment.deleteMany({}), MonthlyReport.deleteMany({}), PeiPlan.deleteMany({})]);
    patient = await Patient.create({ fullName: 'Lucas Almeida', phone: '(62) 99999-1234', status: 'active' });
});

describe('resumo da sessão para a família', () => {
    const okText = 'Olá! Hoje Lucas pediu "mais bola" sozinho três vezes. Para casa: nomear objetos no banho 💚';

    it('sugere texto com as áreas e marcadores; bloqueia rascunho', async () => {
        const draft = await evo({ status: 'draft' });
        const r = await asDoc(request(app).get(`/v2/evolutions/${draft._id}/family-summary`));
        expect(r.status).toBe(200);
        expect(r.body.data.suggestion).toContain('Lucas trabalhou linguagem expressiva');
        expect(r.body.data.canSend).toBe(false);
        const s = await asDoc(request(app).post(`/v2/evolutions/${draft._id}/family-summary/send`)).send({ text: okText });
        expect(s.status).toBe(409);
        expect(queueAdd).not.toHaveBeenCalled();
    });

    it('recusa texto com marcador e envia uma vez só (idempotente)', async () => {
        const e = await evo();
        const bad = await asDoc(request(app).post(`/v2/evolutions/${e._id}/family-summary/send`)).send({ text: 'Olá! Hoje [conte um avanço da sessão] foi ótimo 💚' });
        expect(bad.status).toBe(400);
        const first = await asDoc(request(app).post(`/v2/evolutions/${e._id}/family-summary/send`)).send({ text: okText });
        expect(first.status).toBe(201);
        expect(first.body.data.phoneLast4).toBe('1234');
        const again = await asDoc(request(app).post(`/v2/evolutions/${e._id}/family-summary/send`)).send({ text: okText });
        expect(again.status).toBe(200);
        expect(again.body.meta.idempotent).toBe(true);
        expect(queueAdd).toHaveBeenCalledTimes(1);
        expect(queueAdd.mock.calls[0][1]).toMatchObject({ phone: '5562999991234', message: okText, purpose: 'family_summary' });
        expect(queueAdd.mock.calls[0][2].jobId).toBe(`famsum-${e._id}`);
    });

    it('outro profissional não envia; fila fora do ar libera a trava', async () => {
        const e = await evo();
        expect((await asOther(request(app).post(`/v2/evolutions/${e._id}/family-summary/send`)).send({ text: okText })).status).toBe(403);
        queueAdd.mockRejectedValueOnce(new Error('redis down'));
        const r = await asDoc(request(app).post(`/v2/evolutions/${e._id}/family-summary/send`)).send({ text: okText });
        expect(r.status).toBe(503);
        expect((await Evolution.findById(e._id).lean()).familySummary.status).toBe('failed');
        const retry = await asDoc(request(app).post(`/v2/evolutions/${e._id}/family-summary/send`)).send({ text: okText });
        expect(retry.status).toBe(201);
    });
});

describe('relatório mensal', () => {
    const gen = () => asDoc(request(app).post('/v2/monthly-reports/generate')).send({ patientId: patient._id.toString(), month: '2026-10' });

    it('sem evolução finalizada no mês dá 409', async () => {
        await evo({ status: 'draft' });
        expect((await gen()).status).toBe(409);
    });

    it('calcula só com finalizadas, aprova, envia uma vez e trava edição', async () => {
        await evo({ date: new Date('2026-10-03T00:00:00Z'), evaluationAreas: [{ name: 'Fala', score: 4 }] });
        await evo({ date: new Date('2026-10-24T00:00:00Z'), evaluationAreas: [{ name: 'Fala', score: 6 }] });
        await evo({ date: new Date('2026-10-28T00:00:00Z'), status: 'draft', evaluationAreas: [{ name: 'Fala', score: 9 }] });
        await Appointment.create([
            { patient: patient._id, doctor: DOC, date: new Date('2026-10-03T00:00:00Z'), operationalStatus: 'completed' },
            { patient: patient._id, doctor: DOC, date: new Date('2026-10-17T00:00:00Z'), operationalStatus: 'missed' },
            { patient: patient._id, doctor: DOC, date: new Date('2026-10-24T00:00:00Z'), operationalStatus: 'paid' },
        ]);
        const plan = await PeiPlan.create({ patient: patient._id, doctor: DOC, goals: [{ area: 'Fala', description: 'Pedir com 2 palavras', baseline: 2, target: 8, current: 5 }] });

        const g = await gen();
        expect(g.status).toBe(201);
        const rep = g.body.data;
        expect(rep.data.sessionsWithEvolution).toBe(2);
        expect(rep.data.attendance).toMatchObject({ attended: 2, missed: 1, rate: 67 });
        expect(rep.data.areas[0]).toMatchObject({ name: 'Fala', first: 4, last: 6, delta: 2 });
        expect(rep.data.goals[0]).toMatchObject({ area: 'Fala', progressPct: 50, goalId: String(plan.goals[0]._id) });

        expect((await asDoc(request(app).post(`/v2/monthly-reports/${rep._id}/send`)).send({})).status).toBe(409);
        expect((await asDoc(request(app).post(`/v2/monthly-reports/${rep._id}/approve`))).status).toBe(400);
        await asDoc(request(app).put(`/v2/monthly-reports/${rep._id}`)).send({ summary: 'Lucas ampliou o vocabulário e já pede com duas palavras.' });
        const ap = await asDoc(request(app).post(`/v2/monthly-reports/${rep._id}/approve`));
        expect(ap.status).toBe(200);
        expect(ap.body.data.familyMessage).toContain('outubro de 2026');

        // aviso sugerido tem marcador: precisa trocar
        expect((await asDoc(request(app).post(`/v2/monthly-reports/${rep._id}/send`)).send({})).status).toBe(400);
        const text = 'Olá! O relatório de outubro do Lucas está pronto. Ele já pede com duas palavras 💚';
        const s1 = await asDoc(request(app).post(`/v2/monthly-reports/${rep._id}/send`)).send({ text });
        expect(s1.status).toBe(200);
        expect(s1.body.data.status).toBe('sent');
        const s2 = await asDoc(request(app).post(`/v2/monthly-reports/${rep._id}/send`)).send({ text });
        expect(s2.body.meta.idempotent).toBe(true);
        expect(queueAdd).toHaveBeenCalledTimes(1);
        expect(queueAdd.mock.calls[0][2].jobId).toBe(`monthly-${rep._id}`);

        expect((await asDoc(request(app).put(`/v2/monthly-reports/${rep._id}`)).send({ summary: 'mudar' })).status).toBe(409);
        // Gerar de novo depois de enviado não mexe
        const again = await gen();
        expect(again.body.meta.regenerated).toBe(false);

        const pdf = await asDoc(request(app).get(`/v2/monthly-reports/${rep._id}/pdf`));
        expect(pdf.status).toBe(200);
        expect(pdf.headers['content-type']).toContain('application/pdf');
        expect((await asOther(request(app).get(`/v2/monthly-reports/${rep._id}/pdf`))).status).toBe(403);
    });

    it('editar aprovado volta para rascunho', async () => {
        await evo();
        const rep = (await gen()).body.data;
        await asDoc(request(app).put(`/v2/monthly-reports/${rep._id}`)).send({ summary: 'Resumo com tamanho suficiente para aprovar.' });
        await asDoc(request(app).post(`/v2/monthly-reports/${rep._id}/approve`));
        const ed = await asDoc(request(app).put(`/v2/monthly-reports/${rep._id}`)).send({ nextSteps: 'Seguir com pedidos.' });
        expect(ed.body.data.status).toBe('draft');
    });
});

describe('PEI', () => {
    const create = (goals) => asDoc(request(app).post('/v2/pei')).send({ patientId: patient._id.toString(), specialty: 'fonoaudiologia', goals });

    it('secretária não acessa; alvo precisa ser maior que a base', async () => {
        expect((await asSec(request(app).get(`/v2/pei/patient/${patient._id}`))).status).toBe(403);
        expect((await create([{ area: 'Fala', description: 'x', baseline: 6, target: 4 }])).status).toBe(400);
    });

    it('um ativo por profissional; medição marca alcançada e volta se cair', async () => {
        const c1 = await create([{ area: 'Fala', description: 'Pedir com 2 palavras', baseline: 2, target: 8 }]);
        expect(c1.status).toBe(201);
        const c2 = await create([]);
        expect(c2.body.meta.existing).toBe(true);
        expect(c2.body.data._id).toBe(c1.body.data._id);

        const id = c1.body.data._id;
        const goalId = c1.body.data.goals[0]._id;
        const p1 = await asDoc(request(app).post(`/v2/pei/${id}/goals/${goalId}/progress`)).send({ value: 8, note: 'sozinho' });
        expect(p1.body.data.goals[0]).toMatchObject({ status: 'achieved', current: 8, progressPct: 100 });
        const p2 = await asDoc(request(app).post(`/v2/pei/${id}/goals/${goalId}/progress`)).send({ value: 6 });
        expect(p2.body.data.goals[0]).toMatchObject({ status: 'active', progressPct: 67 });
        expect(p2.body.data.goals[0].history).toHaveLength(2);
        expect((await asDoc(request(app).post(`/v2/pei/${id}/goals/${goalId}/progress`)).send({ value: 11 })).status).toBe(400);
        expect((await asOther(request(app).post(`/v2/pei/${id}/goals/${goalId}/progress`)).send({ value: 5 })).status).toBe(403);

        const ed = await asDoc(request(app).put(`/v2/pei/${id}`)).send({ goals: [{ _id: goalId, area: 'Fala', description: 'Pedir com frase', baseline: 2, target: 8 }, { area: 'Atenção', description: 'Ficar 5 min na atividade', baseline: 3, target: 7 }] });
        expect(ed.body.data.goals).toHaveLength(2);
        expect(ed.body.data.goals[0].history).toHaveLength(2);

        await asDoc(request(app).post(`/v2/pei/${id}/close`));
        expect((await asDoc(request(app).put(`/v2/pei/${id}`)).send({ notes: 'x' })).status).toBe(409);
        expect((await create([])).status).toBe(201);
    });
});
