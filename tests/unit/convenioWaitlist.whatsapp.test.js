/**
 * Lista de interesse em convênio alimentada pelo WhatsApp Web (varredura + captura ao vivo).
 * Garante idempotência, que cadastro já tratado não volta e o cruzamento com pacientes.
 */
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/bullConfig.js', async (importOriginal) => ({
    ...(await importOriginal()),
    whatsappScanQueue: { add: vi.fn(async () => ({ id: 'job-1' })) },
}));

const { matchWaitlistConvenios } = await import('../../constants/convenioWaitlist.js');
const { default: ConvenioWaitlist, ensureConvenioWaitlistIndexes } = await import('../../models/ConvenioWaitlist.js');
const { default: Patient } = await import('../../models/Patient.js');
const { default: Appointment } = await import('../../models/Appointment.js');
const { default: WhatsAppScanRun } = await import('../../models/WhatsAppScanRun.js');
const { recordWhatsappInterest, groupHitsByContact, patientMatchesByPhone } = await import('../../services/convenioWaitlistWhatsapp.js');
const { createConvenioWaitlistRouter } = await import('../../routes/convenioWaitlist.js');
const { whatsappScanQueue } = await import('../../config/bullConfig.js');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-convenio-waitlist';

let mongod;
let app;
let token;

beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    await ensureConvenioWaitlistIndexes();
    const Admin = mongoose.models.Admin || mongoose.model('Admin', new mongoose.Schema({ name: String }), 'admins');
    if (!mongoose.models.Doctor) mongoose.model('Doctor', new mongoose.Schema({ name: String }), 'doctors');
    const admin = await Admin.create({ name: 'Secretária' });
    token = jwt.sign({ id: String(admin._id), role: 'secretary' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    app = express();
    app.use(express.json());
    app.use('/api/convenio-waitlist', createConvenioWaitlistRouter({ submitLimit: { max: 1000 } }));
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongod?.stop();
});

beforeEach(async () => {
    await ConvenioWaitlist.deleteMany({});
    await WhatsAppScanRun.deleteMany({});
    await Patient.collection.deleteMany({});
    await Appointment.collection.deleteMany({});
    whatsappScanQueue.add.mockClear();
});

describe('matchWaitlistConvenios', () => {
    it('reconhece GEAP em qualquer caixa e ignora palavra parecida', () => {
        expect(matchWaitlistConvenios('Boa tarde, vocês atendem pelo Geap?')).toEqual(['geap']);
        expect(matchWaitlistConvenios('GEAP saúde')).toEqual(['geap']);
        expect(matchWaitlistConvenios('geaparecido')).toEqual([]);
        expect(matchWaitlistConvenios('plano Bradesco Saúde')).toEqual(['bradesco']);
        expect(matchWaitlistConvenios('Vocês aceitam Unimed ou GEAP?')).toEqual(['geap', 'unimed']);
    });
});

describe('recordWhatsappInterest', () => {
    const base = { phone: '5562992013573', convenio: 'geap', name: 'Ana', snippet: 'Atende GEAP?', snippetFromContact: true, mentionedBy: ['contato'] };

    it('cria como aguardando/whatsapp_web com a data da conversa e é idempotente', async () => {
        const at = new Date('2026-08-10T13:00:00Z');
        const r1 = await recordWhatsappInterest({ ...base, firstAt: at, lastAt: at });
        const r2 = await recordWhatsappInterest({ ...base, firstAt: at, lastAt: at });
        expect(r1.result).toBe('created');
        expect(r2.result).toBe('updated');
        const docs = await ConvenioWaitlist.find().lean();
        expect(docs).toHaveLength(1);
        expect(docs[0]).toMatchObject({ status: 'aguardando', channel: 'whatsapp_web', name: 'Ana', phone: '5562992013573' });
        expect(docs[0].createdAt.toISOString()).toBe(at.toISOString());
        expect(docs[0].consent.accepted).toBe(false);
    });

    it('casa o telefone sem o 9 com cadastro do site e só completa os dados do WhatsApp', async () => {
        await ConvenioWaitlist.create({ name: 'Maria', phone: '5562992013573', convenio: 'geap', status: 'contatado', activeKey: '5562992013573:geap' });
        const r = await recordWhatsappInterest({ ...base, phone: '556292013573', firstAt: new Date('2026-07-01'), lastAt: new Date('2026-07-02') });
        expect(r.result).toBe('updated');
        const docs = await ConvenioWaitlist.find().lean();
        expect(docs).toHaveLength(1);
        expect(docs[0]).toMatchObject({ name: 'Maria', status: 'contatado' });
        expect(docs[0].whatsapp.snippet).toBe('Atende GEAP?');
        expect(docs[0].whatsapp.mentionedBy).toEqual(['contato']);
    });

    it('não recria quem já foi agendado ou descartado', async () => {
        await ConvenioWaitlist.create({ name: 'Maria', phone: '5562992013573', convenio: 'geap', status: 'descartado' });
        const r = await recordWhatsappInterest(base);
        expect(r.result).toBe('closed');
        expect(await ConvenioWaitlist.countDocuments()).toBe(1);
    });

    it('recusa telefone inválido (ID @lid)', async () => {
        const r = await recordWhatsappInterest({ ...base, phone: '123456789012345' });
        expect(r.result).toBe('invalid');
    });
});

describe('groupHitsByContact', () => {
    it('agrupa por telefone e prefere o trecho do contato', () => {
        const groups = groupHitsByContact([
            { phone: '5562992013573', convenio: 'geap', fromMe: true, body: 'Ainda não atendemos GEAP', at: new Date('2026-08-02') },
            { phone: '5562992013573', convenio: 'geap', fromMe: false, body: 'Vocês atendem GEAP?', at: new Date('2026-08-01'), name: 'Ana' },
            { phone: '5562988887777', convenio: 'geap', fromMe: false, body: 'geap', at: new Date('2026-08-03') },
        ]);
        expect(groups).toHaveLength(2);
        const ana = groups.find((g) => g.phone === '5562992013573');
        expect(ana).toMatchObject({ name: 'Ana', snippet: 'Vocês atendem GEAP?', snippetFromContact: true });
        expect(ana.mentionedBy.sort()).toEqual(['clinica', 'contato']);
        expect(ana.firstAt.toISOString()).toBe(new Date('2026-08-01').toISOString());
    });
});

describe('patientMatchesByPhone', () => {
    it('acha paciente com telefone mascarado e a próxima sessão', async () => {
        const { insertedId } = await Patient.collection.insertOne({ fullName: 'João Paciente', phone: '(62) 99201-3573' });
        const next = new Date(Date.now() + 3 * 864e5);
        await Appointment.collection.insertOne({ patient: insertedId, date: next, operationalStatus: 'pre_agendado' });
        const m = await patientMatchesByPhone(['5562992013573', '5562911112222']);
        expect(m.get('5562992013573')).toMatchObject({ patientName: 'João Paciente' });
        expect(m.get('5562992013573').nextAppointmentAt.toISOString()).toBe(next.toISOString());
        expect(m.has('5562911112222')).toBe(false);
    });
});

describe('rotas da varredura', () => {
    const auth = () => ({ Authorization: `Bearer ${token}` });

    it('enfileira uma varredura e não duplica enquanto está na fila', async () => {
        const r1 = await request(app).post('/api/convenio-waitlist/whatsapp-scan').set(auth()).send({ convenio: 'geap' });
        expect(r1.status).toBe(202);
        expect(whatsappScanQueue.add).toHaveBeenCalledTimes(1);
        const r2 = await request(app).post('/api/convenio-waitlist/whatsapp-scan').set(auth()).send({ convenio: 'geap' });
        expect(r2.status).toBe(200);
        expect(r2.body.alreadyRunning).toBe(true);
        expect(whatsappScanQueue.add).toHaveBeenCalledTimes(1);
        const latest = await request(app).get('/api/convenio-waitlist/whatsapp-scan/latest?convenio=geap').set(auth());
        expect(latest.body.run.status).toBe('queued');
    });

    it('recusa convênio inválido', async () => {
        const r = await request(app).post('/api/convenio-waitlist/whatsapp-scan').set(auth()).send({ convenio: 'amil' });
        expect(r.status).toBe(400);
    });

    it('lista filtra por canal e traz o cruzamento com paciente', async () => {
        await ConvenioWaitlist.create({ name: 'Site', phone: '5562911112222', convenio: 'geap', status: 'aguardando', activeKey: '5562911112222:geap' });
        await recordWhatsappInterest({ phone: '5562992013573', convenio: 'geap', name: 'Ana', snippet: 'GEAP?', snippetFromContact: true, mentionedBy: ['contato'] });
        await Patient.collection.insertOne({ fullName: 'Ana Paciente', phone: '62992013573' });

        const wa = await request(app).get('/api/convenio-waitlist?channel=whatsapp_web').set(auth());
        expect(wa.status).toBe(200);
        expect(wa.body.data).toHaveLength(1);
        expect(wa.body.data[0]).toMatchObject({ channel: 'whatsapp_web', patientMatch: { patientName: 'Ana Paciente' } });

        const site = await request(app).get('/api/convenio-waitlist?channel=site').set(auth());
        expect(site.body.data.map((d) => d.name)).toEqual(['Site']);
        expect(site.body.data[0].channel).toBe('site');
    });
});
