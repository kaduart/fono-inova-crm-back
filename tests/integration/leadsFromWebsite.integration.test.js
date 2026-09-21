/**
 * POST /api/leads/from-website — formatos aceitos pelo endpoint de leads do site.
 * (Independente da lista de interesse de convênios.)
 *
 * Cobre o formato original ({ dadosPessoais }) e o formato "flat" que o site envia ({ nome, telefone }).
 * O controller do módulo de leads e o envio ao Meta CAPI são mockados: aqui só interessa a rota.
 */
import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../controllers/leadController.js', () => {
    const noop = () => {};
    return {
        convertLeadToPatient: noop,
        createLeadFromAd: noop,
        createLeadFromSheet: noop,
        createNewFollowup: noop,
        getLeadByPhone: noop,
        getSheetMetrics: noop,
        getWeeklyMetrics: noop,
        googleLeadWebhook: noop,
        getHistoryMetrics: noop,
        metaLeadWebhook: noop,
    };
});

const sendLeadToMeta = vi.fn().mockResolvedValue({});
vi.mock('../../services/metaConversionsService.js', () => ({ sendLeadToMeta: (...args) => sendLeadToMeta(...args) }));

const { default: Lead } = await import('../../models/Leads.js');
const { default: leadsRouter } = await import('../../routes/leads.js');

let mongod;
let app;

const post = (body) => request(app).post('/api/leads/from-website').send(body);

beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    app = express();
    app.use(express.json());
    app.use('/api/leads', leadsRouter);
}, 60000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
});

beforeEach(async () => {
    await Lead.deleteMany({});
    sendLeadToMeta.mockClear();
});

describe('formato original: dadosPessoais', () => {
    it('cria o lead com telefone normalizado e origem do site', async () => {
        const res = await post({
            dadosPessoais: { nome: 'Ana Paula', telefone: '(62) 99201-3573', email: 'Ana@Email.com' },
            contexto: { pagePath: '/fonoaudiologia-anapolis' },
            origem: { source: 'direct' },
        });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ success: true, duplicate: false });

        const lead = await Lead.findById(res.body.leadId).lean();
        expect(lead.name).toBe('Ana Paula');
        expect(lead.contact.phone).toBe('5562992013573');
        expect(lead.contact.email).toBe('Ana@Email.com');
        expect(lead.origin).toBe('site_fono_inova');
    });
});

describe('formato do site: nome/telefone/email no topo do body', () => {
    it('cria o lead exatamente como no formato original', async () => {
        const res = await post({
            nome: 'Bruno Lima',
            telefone: '+55 (62) 98888-7777',
            email: 'bruno@email.com',
            contexto: { pagePath: '/' },
            origem: { source: 'google', medium: 'cpc' },
        });
        expect(res.status).toBe(201);

        const lead = await Lead.findById(res.body.leadId).lean();
        expect(lead.name).toBe('Bruno Lima');
        expect(lead.contact.phone).toBe('5562988887777');
        expect(lead.origin).toBe('google_ads'); // lógica de origem por UTM continua a mesma
    });

    it('aceita o payload completo que o site envia hoje (flat + dadosPessoais juntos)', async () => {
        const res = await post({
            id: 'lead_123',
            nome: 'Carla Dias',
            telefone: '+55 (62) 97777-6666',
            email: 'carla@email.com',
            dadosPessoais: { nome: 'Carla Dias', telefone: '(62) 97777-6666', email: 'carla@email.com' },
            ga4: { clientId: 'abc.123', sessionId: 'xyz' },
            origem: { source: 'facebook', medium: 'paid' },
            contexto: { pagePath: '/psicologia-infantil-anapolis', pageTitle: 'Psicologia', serviceInterest: 'Psicologia' },
            device: { type: 'mobile' },
        });
        expect(res.status).toBe(201);
        const lead = await Lead.findById(res.body.leadId).lean();
        expect(lead).toMatchObject({ name: 'Carla Dias', origin: 'meta_ads' });
        expect(lead.contact.phone).toBe('5562977776666');
    });
});

describe('precedência e validações', () => {
    it('com os dois formatos divergentes, dadosPessoais prevalece', async () => {
        const res = await post({
            nome: 'Nome do topo',
            telefone: '62911111111',
            dadosPessoais: { nome: 'Nome estruturado', telefone: '(62) 92222-2222' },
        });
        expect(res.status).toBe(201);
        const lead = await Lead.findById(res.body.leadId).lean();
        expect(lead.name).toBe('Nome estruturado');
        expect(lead.contact.phone).toBe('5562922222222');
    });

    it('rejeita sem nome ou sem telefone nos dois formatos (400 e nada gravado)', async () => {
        const invalidos = [
            {},
            { nome: 'Só nome' },
            { telefone: '(62) 99201-3573' },
            { dadosPessoais: { nome: 'Só nome' } },
            { dadosPessoais: { email: 'a@b.com' } },
        ];
        for (const body of invalidos) {
            const res = await post(body);
            expect(res.status).toBe(400);
            expect(res.body).toMatchObject({ success: false, message: 'Dados obrigatórios: nome e telefone' });
        }
        expect(await Lead.countDocuments()).toBe(0);
        expect(sendLeadToMeta).not.toHaveBeenCalled();
    });
});

describe('duplicidade e Meta CAPI (comportamento existente preservado)', () => {
    it('mesmo telefone em 24h é tratado como duplicado, independente do formato usado', async () => {
        const first = await post({ nome: 'Ana Paula', telefone: '(62) 99201-3573' });
        const second = await post({ dadosPessoais: { nome: 'Ana Paula', telefone: '62992013573' } });

        expect(first.status).toBe(201);
        expect(second.status).toBe(200);
        expect(second.body).toMatchObject({ success: true, duplicate: true });
        expect(second.body.leadId).toBe(first.body.leadId);
        expect(await Lead.countDocuments()).toBe(1);
    });

    it('envia ao Meta CAPI apenas para lead novo', async () => {
        await post({ nome: 'Ana Paula', telefone: '(62) 99201-3573' });
        await post({ nome: 'Ana Paula', telefone: '(62) 99201-3573' }); // duplicado
        await post({ nome: 'Sem telefone' }); // inválido
        expect(sendLeadToMeta).toHaveBeenCalledTimes(1);
        expect(sendLeadToMeta).toHaveBeenCalledWith(expect.objectContaining({ phone: '5562992013573', source: 'website' }));
    });
});
