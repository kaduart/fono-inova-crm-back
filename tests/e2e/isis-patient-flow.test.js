/**
 * 🧪 Teste E2E Específico - Paciente Isis
 * 
 * Valida que o fluxo funciona corretamente para a paciente Isis
 * após a correção dos débitos.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import app from '../../server.js';
import PatientBalance from '../../models/PatientBalance.js';

const ISIS_PATIENT_ID = '685b0cfaaec14c7163585b5b';

describe('E2E: Paciente Isis - Fluxo Completo', () => {
    let authToken;

    beforeAll(async () => {
        await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/crm_development');
        
        // Login
        const loginRes = await request(app)
            .post('/api/auth/login')
            .send({ email: 'admin@test.com', password: 'admin123' });
        authToken = loginRes.body.token;
    });

    afterAll(async () => {
        await mongoose.disconnect();
    });

    it('deve ter balance com especialidades corrigidas', async () => {
        const balance = await PatientBalance.findOne({ patient: ISIS_PATIENT_ID });
        
        expect(balance).toBeTruthy();
        expect(balance.currentBalance).toBe(1060);

        // Agrupar por especialidade
        const bySpecialty = {};
        for (const t of balance.transactions.filter(t => t.type === 'debit')) {
            const esp = t.specialty || 'unknown';
            if (!bySpecialty[esp]) bySpecialty[esp] = { count: 0, amount: 0 };
            bySpecialty[esp].count++;
            bySpecialty[esp].amount += t.amount;
        }

        // Verificar que temos as 3 especialidades
        expect(bySpecialty['fonoaudiologia']).toBeTruthy();
        expect(bySpecialty['psicologia']).toBeTruthy();
        expect(bySpecialty['terapia ocupacional']).toBeTruthy();

        console.log('📊 Débitos da Isis por especialidade:', bySpecialty);
    });

    it('deve listar débitos de fonoaudiologia', async () => {
        const res = await request(app)
            .get(`/api/patients/${ISIS_PATIENT_ID}/balance/details?specialty=fonoaudiologia`)
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(res.body.data.length).toBeGreaterThan(0);
        
        // Todos devem ser fonoaudiologia
        for (const debit of res.body.data) {
            expect(debit.specialty).toBe('fonoaudiologia');
        }

        console.log(`✅ ${res.body.data.length} débitos de fono encontrados`);
    });

    it('deve listar débitos de psicologia', async () => {
        const res = await request(app)
            .get(`/api/patients/${ISIS_PATIENT_ID}/balance/details?specialty=psicologia`)
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(res.body.data.length).toBeGreaterThan(0);
        
        for (const debit of res.body.data) {
            expect(debit.specialty).toBe('psicologia');
        }

        console.log(`✅ ${res.body.data.length} débitos de psico encontrados`);
    });

    it('deve listar débitos de terapia ocupacional', async () => {
        const res = await request(app)
            .get(`/api/patients/${ISIS_PATIENT_ID}/balance/details?specialty=terapia%20ocupacional`)
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(res.body.data.length).toBeGreaterThan(0);
        
        for (const debit of res.body.data) {
            expect(debit.specialty).toBe('terapia ocupacional');
        }

        console.log(`✅ ${res.body.data.length} débitos de TO encontrados`);
    });

    it('deve retornar vazio para especialidade inexistente', async () => {
        const res = await request(app)
            .get(`/api/patients/${ISIS_PATIENT_ID}/balance/details?specialty=fisioterapia`)
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(0);
        expect(res.body.summary.totalAmount).toBe(0);
    });
});
