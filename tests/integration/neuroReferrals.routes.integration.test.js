/**
 * Candidatos a neuro — rotas do CRM (/api/neuro-referrals)
 * Mongo em memória + JWT real. Models de Patient/Appointment/AnamnesisReport mínimos (strict:false).
 */
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import NeuroReferral, { ensureNeuroReferralIndexes } from '../../models/NeuroReferral.js';
import { createNeuroReferralsRouter } from '../../routes/neuroReferrals.js';
import { detectNeuroSignals } from '../../services/neuroReferralService.js';

let mongod;
let app;
const tokens = {};
const ids = {};
let Patient;
let Appointment;
let Anamnesis;

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-neuro-referral';
const signToken = (role, id) => jwt.sign({ id: String(id), role }, process.env.JWT_SECRET, { expiresIn: '1h' });
const as = (role) => ({ Authorization: `Bearer ${tokens[role]}` });

const loose = (collection) => new mongoose.Schema({}, { strict: false, collection });

beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    await ensureNeuroReferralIndexes();

    const Admin = mongoose.models.Admin || mongoose.model('Admin', new mongoose.Schema({ name: String }), 'admins');
    const Doctor = mongoose.models.Doctor || mongoose.model('Doctor', new mongoose.Schema({ name: String }), 'doctors');
    Patient = mongoose.models.Patient || mongoose.model('Patient', loose('patients'));
    Appointment = mongoose.models.Appointment || mongoose.model('Appointment', loose('appointments'));
    Anamnesis = mongoose.models.AnamnesisReport || mongoose.model('AnamnesisReport', loose('anamnesisreports'));

    const admin = await Admin.create({ name: 'Admin' });
    const secretary = await Admin.create({ name: 'Recepção' });
    const doctor = await Doctor.create({ name: 'Terapeuta' });
    const otherDoctor = await Doctor.create({ name: 'Outra' });
    ids.doctor = doctor._id;
    ids.otherDoctor = otherDoctor._id;
    tokens.admin = signToken('admin', admin._id);
    tokens.secretary = signToken('secretary', secretary._id);
    tokens.doctor = signToken('doctor', doctor._id);
    tokens.otherDoctor = signToken('doctor', otherDoctor._id);

    app = express();
    app.use(express.json());
    app.use('/api/neuro-referrals', createNeuroReferralsRouter());
}, 60000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongod?.stop();
});

const appt = (patient, specialty, extra = {}) => Appointment.create({
    patient, specialty, doctor: ids.doctor, operationalStatus: 'scheduled', createdAt: new Date(), ...extra,
});

beforeEach(async () => {
    await Promise.all([NeuroReferral.deleteMany({}), Patient.deleteMany({}), Appointment.deleteMany({}), Anamnesis.deleteMany({})]);

    // Ana: fono, queixa com autismo → candidata
    const ana = await Patient.create({ fullName: 'Ana', status: 'active', mainComplaint: 'Suspeita de Autismo, não fala' });
    // Bia: psico, TDAH só na anamnese → candidata
    const bia = await Patient.create({ fullName: 'Bia', status: 'active', mainComplaint: 'Agitação na escola' });
    await Anamnesis.create({ patientId: bia._id, content: { queixaPrincipal: 'Escola pediu avaliação de TDAH' } });
    // Caio: TEA, mas já tem consulta de neuro → fora
    const caio = await Patient.create({ fullName: 'Caio', status: 'active', mainComplaint: 'TEA' });
    // Duda: sem sinal → fora
    const duda = await Patient.create({ fullName: 'Duda', status: 'active', mainComplaint: 'Troca de letras' });
    // Enzo: TEA mas inativo → fora
    const enzo = await Patient.create({ fullName: 'Enzo', status: 'inactive', mainComplaint: 'autista' });
    // Fábio: TEA só em agendamento cancelado → fora (não é paciente da casa)
    const fabio = await Patient.create({ fullName: 'Fábio', status: 'active', mainComplaint: 'autismo' });

    await appt(ana._id, 'fonoaudiologia');
    await appt(bia._id, 'psicologia', { doctor: ids.otherDoctor });
    await appt(caio._id, 'terapia_ocupacional');
    await appt(caio._id, 'neuroped');
    await appt(duda._id, 'fonoaudiologia');
    await appt(enzo._id, 'fonoaudiologia');
    await appt(fabio._id, 'fonoaudiologia', { operationalStatus: 'canceled' });
    Object.assign(ids, { ana: ana._id, bia: bia._id, caio: caio._id, duda: duda._id });
});

describe('detectNeuroSignals', () => {
    it('acha TEA/TDAH sem acento e ignora texto sem sinal', () => {
        expect(detectNeuroSignals([{ where: 'q', text: 'Déficit de Atenção' }]).reasons).toEqual(['tdah']);
        expect(detectNeuroSignals([{ where: 'q', text: 'criança autista' }]).reasons).toEqual(['tea']);
        expect(detectNeuroSignals([{ where: 'q', text: 'gagueira e troca de fonemas' }]).reasons).toEqual([]);
    });
});

describe('POST /scan', () => {
    it('dryRun só conta; varredura cria a_confirmar e é idempotente', async () => {
        const dry = await request(app).post('/api/neuro-referrals/scan?dryRun=1').set(as('secretary'));
        expect(dry.status).toBe(200);
        expect(dry.body.data.candidates).toBe(2);
        expect(dry.body.data.created).toBe(0);
        expect(await NeuroReferral.countDocuments()).toBe(0);

        const first = await request(app).post('/api/neuro-referrals/scan').set(as('admin'));
        expect(first.body.data.created).toBe(2);
        const second = await request(app).post('/api/neuro-referrals/scan').set(as('admin'));
        expect(second.body.data.created).toBe(0);

        const docs = await NeuroReferral.find().lean();
        expect(docs.map(d => d.status)).toEqual(['a_confirmar', 'a_confirmar']);
        expect(docs.map(d => String(d.patient)).sort()).toEqual([String(ids.ana), String(ids.bia)].sort());
    });

    it('terapeuta não pode rodar a varredura', async () => {
        const res = await request(app).post('/api/neuro-referrals/scan').set(as('doctor'));
        expect(res.status).toBe(403);
    });
});

describe('fluxo terapeuta → recepção → agenda', () => {
    it('confirma, oferece e vira agendado quando aparece consulta de neuro', async () => {
        await request(app).post('/api/neuro-referrals/scan').set(as('admin'));
        const ref = await NeuroReferral.findOne({ patient: ids.ana });

        // recepção não pode confirmar no lugar da terapeuta
        const blocked = await request(app).patch(`/api/neuro-referrals/${ref._id}`).set(as('secretary')).send({ status: 'oferecido' });
        expect(blocked.status).toBe(409);

        // terapeuta que não atende a paciente não mexe
        const other = await request(app).patch(`/api/neuro-referrals/${ref._id}`).set(as('otherDoctor')).send({ status: 'indicado' });
        expect(other.status).toBe(403);

        const confirmed = await request(app).patch(`/api/neuro-referrals/${ref._id}`).set(as('doctor')).send({ status: 'indicado', note: 'Sinais claros' });
        expect(confirmed.status).toBe(200);
        expect(confirmed.body.data.status).toBe('indicado');

        const offered = await request(app).patch(`/api/neuro-referrals/${ref._id}`).set(as('secretary')).send({ status: 'oferecido' });
        expect(offered.body.data.status).toBe('oferecido');
        expect(offered.body.data.offeredAt).toBeTruthy();

        await appt(ids.ana, 'neuroped');
        const list = await request(app).get('/api/neuro-referrals?status=all').set(as('secretary'));
        const ana = list.body.data.find(d => String(d.patient._id) === String(ids.ana));
        expect(ana.status).toBe('agendado');
        expect(ana.appointment).toBeTruthy();
        expect(ana.patient.fullName).toBe('Ana');

        const summary = await request(app).get('/api/neuro-referrals/summary').set(as('admin'));
        expect(summary.body.data.byStatus.agendado).toBe(1);
        expect(summary.body.data.pendingTherapist).toBe(1);
        expect(summary.body.data.conversionRate).toBe(1);
    });

    it('indicação manual pela ficha é idempotente e confirma sugestão existente', async () => {
        const a = await request(app).post('/api/neuro-referrals').set(as('doctor')).send({ patientId: ids.duda, reasons: ['tdah', 'xx'] });
        expect(a.status).toBe(201);
        expect(a.body.data.reasons).toEqual(['tdah']);
        const b = await request(app).post('/api/neuro-referrals').set(as('doctor')).send({ patientId: ids.duda });
        expect(b.body.created).toBe(false);
        expect(await NeuroReferral.countDocuments({ patient: ids.duda })).toBe(1);

        await request(app).post('/api/neuro-referrals/scan').set(as('admin'));
        const c = await request(app).post('/api/neuro-referrals').set(as('admin')).send({ patientId: ids.ana, reasons: ['tea'] });
        expect(c.body.created).toBe(false);
        expect(c.body.data.status).toBe('indicado');
    });

    it('terapeuta só vê pacientes que atende; recusado não volta na varredura', async () => {
        await request(app).post('/api/neuro-referrals/scan').set(as('admin'));
        const mine = await request(app).get('/api/neuro-referrals').set(as('doctor'));
        expect(mine.body.data.map(d => d.patient.fullName)).toEqual(['Ana']);

        const ana = await NeuroReferral.findOne({ patient: ids.ana });
        await request(app).patch(`/api/neuro-referrals/${ana._id}`).set(as('doctor')).send({ status: 'indicado' });
        const declined = await request(app).patch(`/api/neuro-referrals/${ana._id}`).set(as('secretary'))
            .send({ status: 'recusado', declineReason: 'Vai pensar depois das férias' });
        expect(declined.body.data.status).toBe('recusado');
        expect(declined.body.data.declineReason).toBe('Vai pensar depois das férias');

        const again = await request(app).post('/api/neuro-referrals/scan?dryRun=1').set(as('admin'));
        expect(again.body.data.items.map(i => i.fullName)).not.toContain('Ana');
    });
});
