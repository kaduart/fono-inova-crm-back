/**
 * Rascunho da evolução (fase 1 da sprint prontuário, 03/11/2026).
 *
 * Roda contra um MongoDB real em memória (mongodb-memory-server) porque o que
 * importa aqui é a semântica do banco: upsert idempotente, índice único por
 * agendamento (E11000) e transição atômica draft → finalized.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const mockPublishEvent = vi.fn();
vi.mock('../../infrastructure/events/eventPublisher.js', () => ({
    publishEvent: (...args) => mockPublishEvent(...args),
    EventTypes: { EVOLUTION_CREATED: 'EVOLUTION_CREATED', EVOLUTION_UPDATED: 'EVOLUTION_UPDATED', EVOLUTION_DELETED: 'EVOLUTION_DELETED' },
}));
// Usuário vem do header x-test-user: "<id>:<role>"
vi.mock('../../middleware/amandaAuth.js', () => ({
    flexibleAuth: (req, _res, next) => {
        const [id, role] = String(req.headers['x-test-user'] || '').split(':');
        req.user = { id, role: role || 'doctor', specialty: 'fonoaudiologia' };
        next();
    },
}));
// A rota importa a fila do WhatsApp (resumo para a família); aqui não usamos Redis.
vi.mock('../../config/bullConfig.js', () => ({ whatsappSendQueue: { add: vi.fn() } }));
vi.mock('../../services/generatePDF.js', () => ({ generatePdfFromEvolution: vi.fn() }));
vi.mock('../../models/Metric.js', () => ({ default: { find: vi.fn().mockResolvedValue([]) } }));
vi.mock('../../models/Patient.js', async () => {
    const m = (await import('mongoose')).default;
    return { default: m.models.Patient || m.model('Patient', new m.Schema({ fullName: String, dateOfBirth: Date, status: String, isLead: Boolean })) };
});
vi.mock('../../models/Appointment.js', async () => {
    const m = (await import('mongoose')).default;
    return { default: m.models.Appointment || m.model('Appointment', new m.Schema({
        patient: { type: m.Schema.Types.ObjectId, ref: 'Patient' },
        doctor: { type: m.Schema.Types.ObjectId, ref: 'Doctor' },
        date: Date, time: String, specialty: String, operationalStatus: String,
    })) };
});
vi.mock('../../models/Doctor.js', async () => {
    const m = (await import('mongoose')).default;
    return { default: m.models.Doctor || m.model('Doctor', new m.Schema({ fullName: String, specialty: String, phoneNumber: String, active: Boolean })) };
});

let mongod, app, Evolution, Appointment, Patient;
const oid = () => new mongoose.Types.ObjectId();
const DOC_A = oid().toString();
const DOC_B = oid().toString();
const asA = (r) => r.set('x-test-user', `${DOC_A}:doctor`);
const asB = (r) => r.set('x-test-user', `${DOC_B}:doctor`);

beforeAll(async () => {
    mongod = await MongoMemoryServer.create({ instance: { storageEngine: 'wiredTiger' } });
    await mongoose.connect(mongod.getUri());
    await import('../../models/Doctor.js');
    Patient = (await import('../../models/Patient.js')).default;
    Appointment = (await import('../../models/Appointment.js')).default;
    Evolution = (await import('../../models/Evolution.js')).default;
    await Evolution.syncIndexes();
    const routes = (await import('../../routes/evolution.v2.js')).default;
    app = express();
    app.use(express.json());
    app.use('/v2/evolutions', routes);
}, 60000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongod?.stop();
});

let patient, appt;
beforeEach(async () => {
    mockPublishEvent.mockReset();
    await Promise.all([Evolution.deleteMany({}), Appointment.deleteMany({}), Patient.deleteMany({})]);
    patient = await Patient.create({ fullName: 'Lucas Teste', status: 'active' });
    appt = await Appointment.create({ patient: patient._id, doctor: DOC_A, date: new Date('2026-11-03T00:00:00Z'), time: '14:00', specialty: 'fonoaudiologia', operationalStatus: 'completed' });
});

const saveDraft = (body, who = asA) => who(request(app).put('/v2/evolutions/draft')).send({ appointmentId: appt._id.toString(), ...body });

describe('PUT /draft', () => {
    it('cria o rascunho na 1ª chamada e atualiza o mesmo nas seguintes (idempotente)', async () => {
        const r1 = await saveDraft({ content: 'primeira versão' });
        expect(r1.status).toBe(200);
        expect(r1.body.data.status).toBe('draft');
        expect(String(r1.body.data.patient)).toBe(String(patient._id)); // paciente vem do agendamento
        expect(r1.body.data.date).toBe('2026-11-03T14:00:00.000Z');

        const r2 = await saveDraft({ content: 'segunda versão' });
        expect(r2.status).toBe(200);
        expect(r2.body.data._id).toBe(r1.body.data._id);
        expect(await Evolution.countDocuments({ appointmentId: appt._id })).toBe(1);
        expect((await Evolution.findById(r1.body.data._id)).content).toBe('segunda versão');
        expect(mockPublishEvent).not.toHaveBeenCalled(); // rascunho não dispara side-effects
    });

    it('ignora status/doctor/patient enviados pelo cliente', async () => {
        const r = await saveDraft({ content: 'x', status: 'finalized', doctor: DOC_B, patient: oid().toString() });
        expect(r.body.data.status).toBe('draft');
        expect(String(r.body.data.doctor)).toBe(DOC_A);
        expect(String(r.body.data.patient)).toBe(String(patient._id));
    });

    it('outro terapeuta não salva rascunho no atendimento de alguém (403)', async () => {
        const r = await saveDraft({ content: 'x' }, asB);
        expect(r.status).toBe(403);
    });

    it('depois de finalizada, o autosave devolve 409 e não reabre a evolução', async () => {
        const r1 = await saveDraft({ content: 'texto clínico' });
        await asA(request(app).post(`/v2/evolutions/${r1.body.data._id}/finalize`)).send({});
        const r2 = await saveDraft({ content: 'tentativa tardia' });
        expect(r2.status).toBe(409);
        expect(r2.body.error.code).toBe('EVOLUTION_ALREADY_FINALIZED');
        expect((await Evolution.findById(r1.body.data._id)).content).toBe('texto clínico');
    });

    it('aparelho com versão antiga recebe DRAFT_CONFLICT em vez de sobrescrever', async () => {
        const r1 = await saveDraft({ content: 'v1' });
        const old = r1.body.meta.lastAutosaveAt;
        await new Promise(r => setTimeout(r, 5));
        const r2 = await saveDraft({ content: 'v2', baseAutosaveAt: old }); // mesmo aparelho, ok
        expect(r2.status).toBe(200);
        const r3 = await saveDraft({ content: 'v-antiga', baseAutosaveAt: old }); // aparelho desatualizado
        expect(r3.status).toBe(409);
        expect(r3.body.error.code).toBe('DRAFT_CONFLICT');
        expect((await Evolution.findById(r1.body.data._id)).content).toBe('v2');
    });

    it('sem appointmentId devolve 400', async () => {
        const r = await asA(request(app).put('/v2/evolutions/draft')).send({ content: 'x' });
        expect(r.status).toBe(400);
    });
});

describe('POST /:id/finalize', () => {
    it('recusa evolução vazia', async () => {
        const r1 = await saveDraft({});
        const r = await asA(request(app).post(`/v2/evolutions/${r1.body.data._id}/finalize`)).send({});
        expect(r.status).toBe(400);
        expect(r.body.error.code).toBe('EMPTY_EVOLUTION');
    });

    it('finaliza uma vez, publica 1 evento e é idempotente no 2º clique', async () => {
        const r1 = await saveDraft({ evaluationAreas: [{ id: 'ling', name: 'Linguagem', score: 6 }] });
        const id = r1.body.data._id;
        const [a, b] = await Promise.all([
            asA(request(app).post(`/v2/evolutions/${id}/finalize`)).send({ content: 'texto final' }),
            asA(request(app).post(`/v2/evolutions/${id}/finalize`)).send({ content: 'texto final' }),
        ]);
        expect(a.status).toBe(200);
        expect(b.status).toBe(200);
        const doc = await Evolution.findById(id);
        expect(doc.status).toBe('finalized');
        expect(doc.finalizedAt).toBeInstanceOf(Date);
        expect(doc.content).toBe('texto final');
        expect(mockPublishEvent).toHaveBeenCalledTimes(1);
        expect(mockPublishEvent.mock.calls[0][0]).toBe('EVOLUTION_CREATED');
    });

    it('outro terapeuta não finaliza (403)', async () => {
        const r1 = await saveDraft({ content: 'x' });
        const r = await asB(request(app).post(`/v2/evolutions/${r1.body.data._id}/finalize`)).send({});
        expect(r.status).toBe(403);
    });
});

describe('POST / (fluxo antigo) com rascunho existente', () => {
    it('reaproveita o rascunho em vez de dar 409 duplicado', async () => {
        const r1 = await saveDraft({ content: 'rascunho' });
        const r = await asA(request(app).post('/v2/evolutions')).send({
            patient: patient._id.toString(), date: '2026-11-03', time: '14:00', specialty: 'fonoaudiologia',
            content: 'salvo pelo botão antigo', appointmentId: appt._id.toString(),
        });
        expect(r.status).toBe(201);
        expect(r.body.data._id).toBe(r1.body.data._id);
        expect(r.body.data.status).toBe('finalized');
        expect(await Evolution.countDocuments({})).toBe(1);
    });

    it('evolução nova pelo POST / já nasce finalizada', async () => {
        const r = await asA(request(app).post('/v2/evolutions')).send({
            patient: patient._id.toString(), date: '2026-11-03', time: '15:00', specialty: 'fonoaudiologia', content: 'direto',
        });
        expect(r.status).toBe(201);
        expect(r.body.data.status).toBe('finalized');
    });
});

describe('Leituras ignoram rascunho', () => {
    it('lista, última e pendências tratam rascunho como não feito; legado sem status conta', async () => {
        // legado: evolução antiga sem campo status (como as que já estão em produção)
        await Evolution.collection.insertOne({
            patient: patient._id, doctor: new mongoose.Types.ObjectId(DOC_A), createdBy: new mongoose.Types.ObjectId(DOC_A),
            date: new Date('2026-10-27T14:00:00Z'), specialty: 'fonoaudiologia', content: 'legado',
            evaluationAreas: [{ id: 'ling', name: 'Linguagem', score: 5 }],
        });
        await saveDraft({ content: 'rascunho de hoje' });

        const list = await asA(request(app).get(`/v2/evolutions/patient/${patient._id}`));
        expect(list.body.data.map(e => e.content)).toEqual(['legado']);

        const last = await asA(request(app).get(`/v2/evolutions/patient/${patient._id}/last?specialty=fonoaudiologia`));
        expect(last.body.data.content).toBe('legado');

        const pending = await asA(request(app).get('/v2/evolutions/pending'));
        expect(pending.body.data).toHaveLength(1);
        expect(pending.body.data[0].draft).toBeTruthy();
        expect(String(pending.body.data[0].lastAppointmentId)).toBe(String(appt._id));
        expect(pending.body.data[0].lastCompletedTime).toBe('14:00');
        expect(String(pending.body.data[0].draft.appointmentId)).toBe(String(appt._id));

        const drafts = await asA(request(app).get('/v2/evolutions/drafts'));
        expect(drafts.body.data).toHaveLength(1);
        expect((await asB(request(app).get('/v2/evolutions/drafts'))).body.data).toHaveLength(0);
    });

    it('GET /appointment/:id não mostra rascunho para outro terapeuta', async () => {
        await saveDraft({ content: 'privado' });
        const mine = await asA(request(app).get(`/v2/evolutions/appointment/${appt._id}`));
        expect(mine.body.data.content).toBe('privado');
        const other = await asB(request(app).get(`/v2/evolutions/appointment/${appt._id}`));
        expect(other.body.data).toBeNull();
    });
});

describe('GET /pending/by-doctor (coordenação)', () => {
    const asAdmin = (r) => r.set('x-test-user', `${oid()}:admin`);
    let Doctor;
    beforeEach(async () => {
        Doctor = mongoose.model('Doctor');
        await Doctor.deleteMany({});
        await Doctor.create([
            { _id: DOC_A, fullName: 'Ana Souza', specialty: 'fonoaudiologia', phoneNumber: '62999990000', active: true },
            { _id: DOC_B, fullName: 'Bruna Reis', specialty: 'psicologia', phoneNumber: '62988880000', active: true },
        ]);
    });

    it('terapeuta não acessa (403)', async () => {
        const res = await asA(request(app).get('/v2/evolutions/pending/by-doctor'));
        expect(res.status).toBe(403);
    });

    it('agrupa por profissional, conta rascunhos e some ao finalizar', async () => {
        const p2 = await Patient.create({ fullName: 'Maria Clara', status: 'active' });
        // 2 dias antes do agendamento fixo da Ana (03/11): sem empate de atraso em qualquer dia
        // (com "2 dias atrás" empatava em 05/11 e a ordem ficava aleatória).
        const twoDaysBefore = new Date('2026-11-01T00:00:00Z');
        await Appointment.create({ patient: p2._id, doctor: DOC_B, date: twoDaysBefore, time: '09:00', specialty: 'psicologia', operationalStatus: 'paid' });
        const draft = await saveDraft({ content: 'rascunho' });
        expect(draft.status).toBe(200);

        const res = await asAdmin(request(app).get('/v2/evolutions/pending/by-doctor'));
        expect(res.status).toBe(200);
        expect(res.body.meta).toMatchObject({ total: 2, doctors: 2, drafts: 1 });
        // Mais atrasado primeiro
        expect(res.body.data.map(d => d.fullName)).toEqual(['Bruna Reis', 'Ana Souza']);
        const bruna = res.body.data[0];
        expect(bruna.phoneNumber).toBe('62988880000');
        expect(bruna.items[0]).toMatchObject({ fullName: 'Maria Clara', draft: null });
        expect(res.body.data[1]).toMatchObject({ pendingCount: 1, draftCount: 1 });
        expect(bruna.items[0].daysLate).toBe(res.body.data[1].items[0].daysLate + 2);

        const fin = await asA(request(app).post(`/v2/evolutions/${draft.body.data._id}/finalize`)).send({ content: 'final' });
        expect(fin.status).toBe(200);
        const after = await asAdmin(request(app).get('/v2/evolutions/pending/by-doctor'));
        expect(after.body.data.map(d => d.fullName)).toEqual(['Bruna Reis']);
    });

    it('profissional inativo fica de fora', async () => {
        await Doctor.updateOne({ _id: DOC_A }, { active: false });
        const res = await asAdmin(request(app).get('/v2/evolutions/pending/by-doctor'));
        expect(res.body.data).toHaveLength(0);
    });
});
