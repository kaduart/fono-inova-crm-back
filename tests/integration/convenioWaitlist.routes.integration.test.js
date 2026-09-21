/**
 * Lista de INTERESSE em convênios — rotas do CRM (/api/convenio-waitlist)
 *
 * Cadastro público vindo do site + gestão autenticada (admin/secretary).
 * Usa Mongo em memória e JWT real assinado com o mesmo segredo do middleware de auth.
 */
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WAITLIST_CONSENT_VERSIONS } from '../../constants/convenioWaitlist.js';
import ConvenioWaitlist, { ensureConvenioWaitlistIndexes } from '../../models/ConvenioWaitlist.js';
import { createConvenioWaitlistRouter } from '../../routes/convenioWaitlist.js';

const CONSENT = { aceito: true, versao: WAITLIST_CONSENT_VERSIONS[0] };

let mongod;
let app;
const tokens = {};

const signToken = (role, id) => jwt.sign({ id: String(id), role }, process.env.JWT_SECRET || 'secreta', { expiresIn: '1h' });
const bearer = (role) => ({ Authorization: `Bearer ${tokens[role]}` });

const cadastro = (overrides = {}) => ({
    nome: 'Maria da Silva',
    telefone: '(62) 99201-3573',
    email: 'maria@email.com',
    convenio: 'geap',
    especialidade: 'Terapia Ocupacional',
    idadeCrianca: 4,
    periodo: 'Manhã',
    consentimento: CONSENT,
    contexto: { pagePath: '/convenio-geap-anapolis' },
    ...overrides,
});

beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    await ensureConvenioWaitlistIndexes(); // mesmo caminho usado no boot do server.js (autoIndex é off em produção)

    // O middleware de auth confere a existência do usuário no model Admin/Doctor pelo id do token
    const Admin = mongoose.models.Admin || mongoose.model('Admin', new mongoose.Schema({ name: String }), 'admins');
    const Doctor = mongoose.models.Doctor || mongoose.model('Doctor', new mongoose.Schema({ name: String }), 'doctors');
    const admin = await Admin.create({ name: 'Admin' });
    const secretary = await Admin.create({ name: 'Secretária' });
    const doctor = await Doctor.create({ name: 'Profissional' });
    tokens.admin = signToken('admin', admin._id);
    tokens.secretary = signToken('secretary', secretary._id);
    tokens.doctor = signToken('doctor', doctor._id);

    app = express();
    app.use(express.json());
    // limite alto: estes testes fazem muitos POSTs do mesmo IP (o limite é testado em outro arquivo)
    app.use('/api/convenio-waitlist', createConvenioWaitlistRouter({ submitLimit: { max: 1000 } }));
}, 60000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
});

beforeEach(async () => {
    await ConvenioWaitlist.deleteMany({});
});

describe('POST /api/convenio-waitlist (público)', () => {
    it('cria o cadastro com telefone normalizado, status aguardando e consentimento com data e versão', async () => {
        const before = Date.now();
        const res = await request(app).post('/api/convenio-waitlist').send(cadastro());
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ success: true, duplicate: false });

        const doc = await ConvenioWaitlist.findById(res.body.id).lean();
        expect(doc).toMatchObject({
            name: 'Maria da Silva',
            phone: '5562992013573',
            convenio: 'geap',
            status: 'aguardando',
            especialidade: 'Terapia Ocupacional',
            idadeCrianca: 4,
            requestCount: 1,
            activeKey: '5562992013573:geap',
        });
        expect(doc.source.pagePath).toBe('/convenio-geap-anapolis');
        expect(doc.consent).toMatchObject({ accepted: true, version: WAITLIST_CONSENT_VERSIONS[0] });
        expect(doc.consent.acceptedAt.getTime()).toBeGreaterThanOrEqual(before);
        expect(doc.consent.acceptedAt.getTime()).toBeLessThanOrEqual(Date.now());
        expect(doc.submissions[0].consentVersion).toBe(WAITLIST_CONSENT_VERSIONS[0]);
    });

    it('e-mail é opcional: sem e-mail o cadastro é criado', async () => {
        const res = await request(app).post('/api/convenio-waitlist').send(cadastro({ email: undefined }));
        expect(res.status).toBe(201);
        expect((await ConvenioWaitlist.findById(res.body.id).lean()).email).toBeNull();
    });

    it('sem consentimento válido não grava nada (ausente, false, versão desconhecida)', async () => {
        const invalidos = [
            cadastro({ consentimento: undefined }),
            cadastro({ consentimento: { aceito: false, versao: CONSENT.versao } }),
            cadastro({ consentimento: { aceito: true, versao: 'versao-inventada' } }),
            cadastro({ consentimento: { aceito: true } }),
        ];
        for (const body of invalidos) {
            const res = await request(app).post('/api/convenio-waitlist').send(body);
            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
        }
        expect(await ConvenioWaitlist.countDocuments()).toBe(0);
    });

    it('não duplica a mesma pessoa no mesmo convênio: atualiza e guarda o histórico', async () => {
        await request(app).post('/api/convenio-waitlist').send(cadastro());
        const res = await request(app)
            .post('/api/convenio-waitlist')
            .send(cadastro({ especialidade: 'Fonoaudiologia', idadeCrianca: 6 }));

        expect(res.status).toBe(200);
        expect(res.body.duplicate).toBe(true);
        expect(await ConvenioWaitlist.countDocuments()).toBe(1);

        const doc = await ConvenioWaitlist.findOne().lean();
        expect(doc.requestCount).toBe(2);
        expect(doc.especialidade).toBe('Fonoaudiologia');
        expect(doc.idadeCrianca).toBe(6);
        expect(doc.submissions).toHaveLength(2);
        // o consentimento original (data e versão) é preservado; o reenvio fica registrado no histórico
        expect(doc.consent.version).toBe(WAITLIST_CONSENT_VERSIONS[0]);
    });

    it('reenvio completa o e-mail quando o cadastro ativo ainda não tinha', async () => {
        await request(app).post('/api/convenio-waitlist').send(cadastro({ email: undefined }));
        await request(app).post('/api/convenio-waitlist').send(cadastro({ email: 'nova@email.com' }));
        expect((await ConvenioWaitlist.findOne().lean()).email).toBe('nova@email.com');
    });

    it('permite a mesma pessoa em outro convênio', async () => {
        await request(app).post('/api/convenio-waitlist').send(cadastro());
        const res = await request(app).post('/api/convenio-waitlist').send(cadastro({ convenio: 'bradesco' }));
        expect(res.status).toBe(201);
        expect(await ConvenioWaitlist.countDocuments()).toBe(2);
    });

    it('permite novo cadastro depois que o anterior foi descartado (fluxo real via PATCH)', async () => {
        const first = await request(app).post('/api/convenio-waitlist').send(cadastro());
        const discard = await request(app)
            .patch(`/api/convenio-waitlist/${first.body.id}`)
            .set(bearer('secretary'))
            .send({ status: 'descartado' });
        expect(discard.status).toBe(200);

        const res = await request(app).post('/api/convenio-waitlist').send(cadastro());
        expect(res.status).toBe(201);
        expect(res.body.id).not.toBe(first.body.id);
        expect(await ConvenioWaitlist.countDocuments()).toBe(2);
    });

    it('rejeita payload inválido sem gravar nada', async () => {
        const invalidos = [
            cadastro({ telefone: '12' }),
            cadastro({ convenio: 'unimed' }),
            cadastro({ nome: 'Jo' }),
            cadastro({ email: 'sem-arroba' }),
        ];
        for (const body of invalidos) {
            const res = await request(app).post('/api/convenio-waitlist').send(body);
            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
        }
        expect(await ConvenioWaitlist.countDocuments()).toBe(0);
    });

    it('a unicidade é garantida pelo banco: índice único parcial em activeKey existe', async () => {
        const indexes = await ConvenioWaitlist.collection.indexes();
        const index = indexes.find((item) => item.name === 'uniq_active_phone_convenio');
        expect(index).toBeTruthy();
        expect(index.unique).toBe(true);
        expect(index.key).toEqual({ activeKey: 1 });
        expect(index.partialFilterExpression).toEqual({ activeKey: { $type: 'string' } });
    });
});

describe('rotas protegidas', () => {
    it('exigem token (401) e perfil admin/secretary (403 para médico)', async () => {
        expect((await request(app).get('/api/convenio-waitlist')).status).toBe(401);
        expect((await request(app).get('/api/convenio-waitlist/summary')).status).toBe(401);
        expect((await request(app).patch('/api/convenio-waitlist/507f1f77bcf86cd799439011').send({ status: 'contatado' })).status).toBe(401);

        expect((await request(app).get('/api/convenio-waitlist').set(bearer('doctor'))).status).toBe(403);
        expect((await request(app).get('/api/convenio-waitlist/summary').set(bearer('doctor'))).status).toBe(403);
        expect((await request(app).patch('/api/convenio-waitlist/507f1f77bcf86cd799439011').set(bearer('doctor')).send({ status: 'contatado' })).status).toBe(403);

        expect((await request(app).get('/api/convenio-waitlist').set(bearer('secretary'))).status).toBe(200);
        expect((await request(app).get('/api/convenio-waitlist').set(bearer('admin'))).status).toBe(200);
    });

    it('rejeita token inválido', async () => {
        const res = await request(app).get('/api/convenio-waitlist').set({ Authorization: 'Bearer token-invalido' });
        expect(res.status).toBe(401);
    });
});

describe('GET /api/convenio-waitlist', () => {
    beforeEach(async () => {
        const base = new Date('2026-09-01T12:00:00Z').getTime();
        const rows = [
            { name: 'Ana Souza', phone: '5562990000001', convenio: 'geap', especialidade: 'Fonoaudiologia', status: 'aguardando' },
            { name: 'Bruno Lima', phone: '5562990000002', convenio: 'ipasgo', especialidade: 'Terapia Ocupacional', status: 'aguardando' },
            { name: 'Carla Dias', phone: '5562990000003', convenio: 'geap', especialidade: 'Terapia Ocupacional', status: 'contatado' },
            { name: 'Diego Reis', phone: '5562990000004', convenio: 'bradesco', especialidade: 'Psicologia infantil', status: 'agendado' },
        ];
        for (let i = 0; i < rows.length; i += 1) {
            await ConvenioWaitlist.create({ ...rows[i], createdAt: new Date(base + i * 86400000) });
        }
    });

    it('lista com paginação, rótulo do convênio e mais recentes primeiro por padrão', async () => {
        const res = await request(app).get('/api/convenio-waitlist').set(bearer('secretary'));
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ total: 4, page: 1, limit: 20, pages: 1 });
        expect(res.body.data.map((d) => d.name)).toEqual(['Diego Reis', 'Carla Dias', 'Bruno Lima', 'Ana Souza']);
        expect(res.body.data[0].convenioLabel).toBe('Bradesco Saúde');
    });

    it('order=asc devolve a fila por ordem de chegada', async () => {
        const res = await request(app).get('/api/convenio-waitlist?order=asc').set(bearer('secretary'));
        expect(res.body.data.map((d) => d.name)).toEqual(['Ana Souza', 'Bruno Lima', 'Carla Dias', 'Diego Reis']);
    });

    it('filtra por convênio, status, especialidade e combinações', async () => {
        const get = (qs) => request(app).get(`/api/convenio-waitlist?${qs}`).set(bearer('admin'));
        expect((await get('convenio=geap')).body.total).toBe(2);
        expect((await get('status=aguardando')).body.total).toBe(2);
        expect((await get('convenio=geap&status=contatado')).body.data[0].name).toBe('Carla Dias');
        expect((await get('especialidade=Terapia%20Ocupacional')).body.total).toBe(2);
        expect((await get('convenio=inexistente')).body.total).toBe(4); // valor fora da lista é ignorado
    });

    it('busca por nome, telefone e e-mail sem interpretar regex do usuário', async () => {
        const get = (search) => request(app).get('/api/convenio-waitlist').query({ search }).set(bearer('admin'));
        expect((await get('bruno')).body.total).toBe(1);
        expect((await get('0000003')).body.total).toBe(1);
        expect((await get('.*')).body.total).toBe(0);
        expect((await get('(')).status).toBe(200);
    });

    it('filtra por período de cadastro e ignora datas inválidas', async () => {
        const get = (qs) => request(app).get(`/api/convenio-waitlist?${qs}`).set(bearer('admin'));
        expect((await get('from=2026-09-03T00:00:00Z')).body.total).toBe(2);
        expect((await get('to=2026-09-01T23:59:59Z')).body.total).toBe(1);
        expect((await get('from=nao-e-data')).body.total).toBe(4);
    });

    it('limita page size a 100 e trata page/limit inválidos', async () => {
        const res = await request(app).get('/api/convenio-waitlist?limit=9999&page=-3').set(bearer('admin'));
        expect(res.body.limit).toBe(100);
        expect(res.body.page).toBe(1);
        const paged = await request(app).get('/api/convenio-waitlist?limit=2&page=2&order=asc').set(bearer('admin'));
        expect(paged.body.data.map((d) => d.name)).toEqual(['Carla Dias', 'Diego Reis']);
        expect(paged.body.pages).toBe(2);
    });
});

describe('GET /api/convenio-waitlist/summary', () => {
    it('conta por convênio e status, incluindo convênios sem cadastro', async () => {
        await ConvenioWaitlist.create([
            { name: 'A A A', phone: '5562990000001', convenio: 'geap', status: 'aguardando' },
            { name: 'B B B', phone: '5562990000002', convenio: 'geap', status: 'aguardando' },
            { name: 'C C C', phone: '5562990000003', convenio: 'geap', status: 'contatado' },
            { name: 'D D D', phone: '5562990000004', convenio: 'ipasgo', status: 'descartado' },
        ]);
        const res = await request(app).get('/api/convenio-waitlist/summary').set(bearer('secretary'));
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(4);
        expect(res.body.porConvenio.geap).toMatchObject({ label: 'GEAP', total: 3, aguardando: 2, contatado: 1, agendado: 0, descartado: 0 });
        expect(res.body.porConvenio.ipasgo).toMatchObject({ total: 1, descartado: 1 });
        expect(res.body.porConvenio.bradesco).toMatchObject({ label: 'Bradesco Saúde', total: 0, aguardando: 0 });
    });
});

describe('PATCH /api/convenio-waitlist/:id', () => {
    const criar = () => request(app).post('/api/convenio-waitlist').send(cadastro()).then((res) => res.body.id);

    it("marcar 'contatado' registra notifiedAt uma única vez", async () => {
        const id = await criar();
        const first = await request(app).patch(`/api/convenio-waitlist/${id}`).set(bearer('secretary')).send({ status: 'contatado' });
        expect(first.status).toBe(200);
        expect(first.body.status).toBe('contatado');
        expect(first.body.notifiedAt).toBeTruthy();
        expect(first.body.convenioLabel).toBe('GEAP');

        const again = await request(app).patch(`/api/convenio-waitlist/${id}`).set(bearer('secretary')).send({ status: 'agendado' });
        expect(again.body.status).toBe('agendado');
        expect(again.body.notifiedAt).toBe(first.body.notifiedAt);
    });

    it('atualiza notas (limitadas a 2000 caracteres) sem mexer no status', async () => {
        const id = await criar();
        const res = await request(app).patch(`/api/convenio-waitlist/${id}`).set(bearer('admin')).send({ notes: 'x'.repeat(3000) });
        expect(res.status).toBe(200);
        expect(res.body.notes).toHaveLength(2000);
        expect(res.body.status).toBe('aguardando');
    });

    it('valida status, corpo vazio, id malformado e id inexistente', async () => {
        const id = await criar();
        const patch = (target, body) => request(app).patch(`/api/convenio-waitlist/${target}`).set(bearer('admin')).send(body);
        expect((await patch(id, { status: 'qualquer' })).status).toBe(400);
        expect((await patch(id, {})).status).toBe(400);
        expect((await patch('nao-e-id', { status: 'contatado' })).status).toBe(400);
        expect((await patch('507f1f77bcf86cd799439011', { status: 'contatado' })).status).toBe(404);
    });

    it('status ativo mantém a chave de unicidade; agendado/descartado libera', async () => {
        const id = await criar();
        const patch = (body) => request(app).patch(`/api/convenio-waitlist/${id}`).set(bearer('admin')).send(body);

        await patch({ status: 'contatado' });
        expect((await ConvenioWaitlist.findById(id).lean()).activeKey).toBe('5562992013573:geap');

        await patch({ status: 'agendado' });
        expect((await ConvenioWaitlist.findById(id).lean()).activeKey).toBeUndefined();

        await patch({ status: 'aguardando' }); // reabrir sem outro ativo é permitido
        expect((await ConvenioWaitlist.findById(id).lean()).activeKey).toBe('5562992013573:geap');
    });

    it('reativar um cadastro quando já existe outro ativo do mesmo telefone + convênio devolve 409', async () => {
        const firstId = await criar();
        await request(app).patch(`/api/convenio-waitlist/${firstId}`).set(bearer('admin')).send({ status: 'descartado' });
        const secondId = await criar(); // novo cadastro ativo

        const reopen = await request(app).patch(`/api/convenio-waitlist/${firstId}`).set(bearer('admin')).send({ status: 'aguardando' });
        expect(reopen.status).toBe(409);
        expect((await ConvenioWaitlist.findById(firstId).lean()).status).toBe('descartado');
        expect((await ConvenioWaitlist.findById(secondId).lean()).status).toBe('aguardando');

        const active = await ConvenioWaitlist.countDocuments({ phone: '5562992013573', convenio: 'geap', status: { $in: ['aguardando', 'contatado'] } });
        expect(active).toBe(1);
    });
});
