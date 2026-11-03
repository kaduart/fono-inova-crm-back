/**
 * Anamnese e relatório escolar: o front manda o formulário inteiro em `content`.
 * Sem `content` no schema, o strict do Mongoose descartava tudo e o relatório salvava vazio (03/11/2026).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import AnamnesisReport from '../../models/AnamnesisReport.js';
import SchoolReport from '../../models/SchoolReport.js';

let mongod;
beforeAll(async () => {
    mongod = await MongoMemoryServer.create({ instance: { storageEngine: 'wiredTiger' } });
    await mongoose.connect(mongod.getUri());
}, 60000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });

const base = { patientId: new mongoose.Types.ObjectId(), patientName: 'Lucas', createdBy: new mongoose.Types.ObjectId(), createdByName: 'Ana' };

describe('relatórios guardam o formulário enviado em content', () => {
    it('anamnese: cria e atualiza sem perder seções', async () => {
        const content = {
            identification: { mainComplaint: 'atraso de fala' },
            familyHistory: { parents: { mother: { age: '34 anos' } }, siblingsInfo: '1 irmã' },
            habits: { sleep: 'Acorda à noite' },
        };
        const doc = await AnamnesisReport.create({ ...base, date: '2026-11-03', content });
        const saved = await AnamnesisReport.findById(doc._id).lean();
        expect(saved.content).toEqual(content);
        expect(saved.date).toBeInstanceOf(Date);

        await AnamnesisReport.findByIdAndUpdate(doc._id, { content: { ...content, habits: { sleep: 'Dorme bem' } } }, { new: true, runValidators: true });
        const upd = await AnamnesisReport.findById(doc._id).lean();
        expect(upd.content.habits.sleep).toBe('Dorme bem');
        expect(upd.content.identification.mainComplaint).toBe('atraso de fala');
    });

    it('relatório escolar: guarda content', async () => {
        const content = { schoolInfo: { schoolName: 'Pingo de Gente' }, recommendations: { forSchool: 'rotina visual' } };
        const doc = await SchoolReport.create({ ...base, title: 'Rel', schoolYear: '2026', schoolInfo: { schoolName: 'Pingo', grade: 'M2' }, content });
        const saved = await SchoolReport.findById(doc._id).lean();
        expect(saved.content).toEqual(content);
    });
});

describe('rota do relatório escolar', () => {
    it('POST com tudo em content passa na validação (ano, escola e série vêm de content)', async () => {
        const express = (await import('express')).default;
        const request = (await import('supertest')).default;
        if (!mongoose.models.Patient) mongoose.model('Patient', new mongoose.Schema({ fullName: String }));
        const routes = (await import('../../routes/reports/schoolReports.js')).default;
        const app = express(); app.use(express.json()); app.use('/s', routes);
        const content = { schoolYear: '2026', semester: 'annual', schoolInfo: { schoolName: 'Pingo de Gente', grade: 'Maternal II' } };
        const ok = await request(app).post('/s').send({ ...base, title: 'Rel', content });
        expect(ok.status).toBe(201);
        const saved = await SchoolReport.findById(ok.body.report._id).lean();
        expect(saved.schoolInfo.schoolName).toBe('Pingo de Gente');
        expect(saved.content).toEqual(content);

        const bad = await request(app).post('/s').send({ ...base, title: 'Rel', content: { schoolYear: '2026', schoolInfo: {} } });
        expect(bad.status).toBe(400);
    });
});
