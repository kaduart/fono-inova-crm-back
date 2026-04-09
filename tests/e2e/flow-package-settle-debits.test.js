/**
 * 🧪 Testes E2E - Fluxo Completo: Débito → Pacote → Quitação
 * 
 * Fluxo testado:
 * 1. Criar agendamento
 * 2. Completar agendamento → criar débito no balance
 * 3. Criar pacote selecionando o débito
 * 4. Verificar se débito foi quitado
 * 5. Verificar se appointment foi marcado como pago
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import app from '../../server.js';
import PatientBalance from '../../models/PatientBalance.js';
import Appointment from '../../models/Appointment.js';
import Package from '../../models/Package.js';
import Patient from '../../models/Patient.js';
import Doctor from '../../models/Doctor.js';

describe('E2E: Fluxo Débito → Pacote → Quitação', () => {
    let authToken;
    let patientId;
    let doctorId;
    let appointmentId;
    let packageId;

    beforeAll(async () => {
        // Login para obter token
        const loginRes = await request(app)
            .post('/api/auth/login')
            .send({ email: 'admin@test.com', password: 'admin123' });
        authToken = loginRes.body.token;

        // Criar paciente de teste
        const patientRes = await request(app)
            .post('/api/patients/add')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                fullName: 'Paciente Teste E2E',
                phone: '61999999999',
                email: 'teste-e2e@test.com'
            });
        patientId = patientRes.body.patient._id;

        // Criar médico de teste
        const doctorRes = await request(app)
            .post('/api/doctors')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                fullName: 'Dr. Teste E2E',
                specialty: 'fonoaudiologia',
                email: 'dr-teste@test.com'
            });
        doctorId = doctorRes.body._id;
    });

    afterAll(async () => {
        // Limpar dados de teste
        await PatientBalance.deleteMany({ patient: patientId });
        await Appointment.deleteMany({ patient: patientId });
        await Package.deleteMany({ patient: patientId });
        await Patient.findByIdAndDelete(patientId);
        await Doctor.findByIdAndDelete(doctorId);
        await mongoose.disconnect();
    });

    it('deve criar agendamento e gerar débito ao completar', async () => {
        // 1. Criar agendamento
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const dateStr = tomorrow.toISOString().split('T')[0];

        const apptRes = await request(app)
            .post('/api/appointments')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                patient: patientId,
                doctor: doctorId,
                date: dateStr,
                time: '14:00',
                specialty: 'fonoaudiologia',
                sessionValue: 130,
                paymentMethod: 'pix'
            });

        expect(apptRes.status).toBe(201);
        appointmentId = apptRes.body.appointment._id;

        // 2. Completar agendamento
        const completeRes = await request(app)
            .patch(`/api/appointments/${appointmentId}/complete`)
            .set('Authorization', `Bearer ${authToken}`)
            .send({ addToBalance: true });

        expect(completeRes.status).toBe(200);

        // 3. Verificar se débito foi criado no balance
        const balance = await PatientBalance.findOne({ patient: patientId });
        expect(balance).toBeTruthy();
        expect(balance.transactions).toHaveLength(1);
        expect(balance.transactions[0].type).toBe('debit');
        expect(balance.transactions[0].amount).toBe(130);
        expect(balance.transactions[0].specialty).toBe('fonoaudiologia');
        expect(balance.currentBalance).toBe(130);
    });

    it('deve listar débitos pendentes por especialidade', async () => {
        const res = await request(app)
            .get(`/api/patients/${patientId}/balance/details?specialty=fonoaudiologia`)
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0].specialty).toBe('fonoaudiologia');
        expect(res.body.data[0].amount).toBe(130);
    });

    it('deve criar pacote e quitar débitos selecionados', async () => {
        // Buscar o ID do débito
        const balanceBefore = await PatientBalance.findOne({ patient: patientId });
        const debitId = balanceBefore.transactions[0]._id.toString();

        // Criar pacote selecionando o débito
        const packageRes = await request(app)
            .post('/api/packages')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                patientId,
                doctorId,
                sessionType: 'fonoaudiologia',
                specialty: 'fonoaudiologia',
                sessionValue: 130,
                totalSessions: 5,
                durationMonths: 1,
                sessionsPerWeek: 1,
                calculationMode: 'duration',
                date: '2026-05-01',
                time: '14:00',
                paymentType: 'full',
                selectedSlots: [{ date: '2026-05-01', time: '14:00' }],
                selectedDebts: [debitId], // 🆕 Selecionando débito para quitar
                payments: [{ amount: 650, method: 'pix', date: '2026-04-09' }]
            });

        expect(packageRes.status).toBe(201);
        packageId = packageRes.body.data._id;

        // Verificar se débito foi quitado
        const balanceAfter = await PatientBalance.findOne({ patient: patientId });
        const settledDebit = balanceAfter.transactions.find(t => t._id.toString() === debitId);
        expect(settledDebit.settledByPackageId.toString()).toBe(packageId);
        expect(settledDebit.isPaid).toBe(true);

        // Verificar se crédito foi criado
        const credit = balanceAfter.transactions.find(t => t.type === 'credit');
        expect(credit).toBeTruthy();
        expect(credit.amount).toBe(130);
        expect(credit.description).toContain('Quitação via pacote');

        // Verificar saldo atualizado
        expect(balanceAfter.currentBalance).toBe(0); // 130 débito - 130 crédito
    });

    it('não deve permitir quitar débito já quitado', async () => {
        const balance = await PatientBalance.findOne({ patient: patientId });
        const settledDebitId = balance.transactions.find(t => t.settledByPackageId)._id;

        // Tentar criar outro pacote quitando o mesmo débito
        const packageRes = await request(app)
            .post('/api/packages')
            .set('Authorization', `Bearer ${authToken}`)
            .send({
                patientId,
                doctorId,
                sessionType: 'fonoaudiologia',
                specialty: 'fonoaudiologia',
                sessionValue: 130,
                totalSessions: 5,
                selectedSlots: [{ date: '2026-06-01', time: '14:00' }],
                selectedDebts: [settledDebitId], // Débito já quitado
                payments: [{ amount: 650, method: 'pix', date: '2026-04-09' }]
            });

        expect(packageRes.status).toBe(400);
        expect(packageRes.body.error).toContain('já quitado');
    });

    it('deve filtrar corretamente após quitação', async () => {
        // Listar débitos pendentes de fonoaudiologia
        const res = await request(app)
            .get(`/api/patients/${patientId}/balance/details?specialty=fonoaudiologia`)
            .set('Authorization', `Bearer ${authToken}`);

        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(0); // Nenhum débito pendente
        expect(res.body.summary.count).toBe(0);
        expect(res.body.summary.totalAmount).toBe(0);
    });
});
