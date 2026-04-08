/**
 * E2E Test CRÍTICO - Payment deve aparecer no Caixa
 * 
 * 🎯 INVARIANTE DE NEGÓCIO: Se payment.status === 'paid', 
 *    então o valor DEVE estar no daily closing
 * 
 * ⚠️ Este teste detecta o BUG onde pagamentos confirmados
 *    não aparecem no caixa da clínica
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import moment from 'moment-timezone';

// ─── SETUP ───────────────────────────────────────────────────────────────────
let mongoServer;
let Patient, Doctor, Appointment, Session, Package, Payment;

beforeAll(async () => {
    mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(mongoServer.getUri());

    Patient = (await import('../../models/Patient.js')).default;
    Doctor = (await import('../../models/Doctor.js')).default;
    Appointment = (await import('../../models/Appointment.js')).default;
    Session = (await import('../../models/Session.js')).default;
    Package = (await import('../../models/Package.js')).default;
    Payment = (await import('../../models/Payment.js')).default;
}, 60_000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
});

beforeEach(async () => {
    const cols = mongoose.connection.collections;
    for (const key in cols) await cols[key].deleteMany({});
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────
async function seedData() {
    const patient = await Patient.create({
        fullName: 'Paciente Caixa Teste',
        phone: '62999990001',
        dateOfBirth: new Date('2010-01-15')
    });
    const doctor = await Doctor.create({
        fullName: 'Dr. Caixa Teste',
        specialty: 'fonoaudiologia',
        phoneNumber: '62999990002',
        licenseNumber: 'CRM-GO-99999',
        email: 'dr@caixa.com'
    });
    return { patient, doctor };
}

async function createPackagePerSession(patient, doctor, sessionValue = 160) {
    return await Package.create({
        patient: patient._id,
        doctor: doctor._id,
        type: 'therapy',
        paymentType: 'per-session',
        totalSessions: 10,
        sessionsDone: 0,
        sessionsRemaining: 10,
        sessionValue: sessionValue,
        totalValue: sessionValue * 10,
        specialty: 'fonoaudiologia',
        sessionType: 'fonoaudiologia',
        sessionsPerWeek: 1,
        durationMonths: 3,
        date: new Date(),
        status: 'active'
    });
}

async function createAppointmentWithSession(patient, doctor, pkg, date, time) {
    const session = await Session.create({
        patient: patient._id,
        doctor: doctor._id,
        date: new Date(date + 'T12:00:00.000Z'),
        time: time,
        sessionType: 'fonoaudiologia',
        sessionValue: pkg ? pkg.sessionValue : 160,
        status: 'completed',
        isPaid: true,
        paymentStatus: 'paid'
    });
    
    const appointment = await Appointment.create({
        patient: patient._id,
        doctor: doctor._id,
        date: new Date(date + 'T12:00:00.000Z'),
        time: time,
        duration: 40,
        specialty: 'fonoaudiologia',
        serviceType: pkg ? 'package_session' : 'evaluation',
        package: pkg ? pkg._id : null,
        session: session._id,
        sessionValue: pkg ? pkg.sessionValue : 160,
        paymentMethod: 'pix',
        operationalStatus: 'completed',
        clinicalStatus: 'completed',
        paymentStatus: 'paid',
        status: 'completed',
        correlationId: new mongoose.Types.ObjectId().toString()
    });
    
    session.appointmentId = appointment._id;
    await session.save();
    
    return appointment;
}

async function createPaidPayment(appointment, patient, doctor, pkg) {
    return await Payment.create({
        patient: patient._id,
        doctor: doctor._id,
        appointment: appointment._id,
        session: appointment.session,
        package: pkg ? pkg._id : null,
        amount: appointment.sessionValue,
        paymentDate: new Date(),
        serviceDate: new Date(),
        paymentMethod: 'pix',
        status: 'paid',
        serviceType: 'session',
        kind: 'session_payment',
        billingType: 'particular',
        paidAt: new Date(),
        confirmedAt: new Date(),
        clinicId: 'default'
    });
}

async function calculateDailyClosing(date) {
    const { calculateDailyClosing } = await import('../../services/dailyClosing/index.js');
    return await calculateDailyClosing(date, 'default');
}

// ─── TESTES CRÍTICOS ─────────────────────────────────────────────────────────
describe('🚨 CRÍTICO: Pagamento Pago DEVE estar no Caixa', () => {
    
    it('INVARIANTE: Payment pago → Valor no caixa', async () => {
        // Arrange
        const { patient, doctor } = await seedData();
        const pkg = await createPackagePerSession(patient, doctor, 160);
        const today = moment().format('YYYY-MM-DD');
        
        // Cria appointment completado
        const appointment = await createAppointmentWithSession(patient, doctor, pkg, today, '09:00');
        
        // Cria payment pago (simula o que o complete deveria fazer)
        const payment = await createPaidPayment(appointment, patient, doctor, pkg);
        
        // Act - Calcula caixa
        const report = await calculateDailyClosing(today);
        
        // Assert - INVARIANTE: Payment pago DEVE estar no caixa
        expect(report.summary.financial.totalReceived).toBe(160);
        expect(report.timelines.payments).toHaveLength(1);
        expect(report.timelines.payments[0].amount).toBe(160);
        expect(report.timelines.payments[0].method).toBe('pix');
        
        // Valida que o payment específico está lá
        const paymentInCash = report.timelines.payments.some(
            p => p.id === payment._id.toString()
        );
        expect(paymentInCash).toBe(true);
        
        console.log('✅ INVARIANTE VALIDADA:', {
            paymentId: payment._id.toString(),
            paymentStatus: payment.status,
            caixaValor: report.summary.financial.totalReceived,
            noCaixa: paymentInCash
        });
    });
    
    it('múltiplos payments devem somar no caixa', async () => {
        const { patient, doctor } = await seedData();
        const pkg = await createPackagePerSession(patient, doctor, 150);
        const today = moment().format('YYYY-MM-DD');
        
        // Cria 3 appointments com payments
        const times = ['09:00', '10:00', '11:00'];
        for (const time of times) {
            const apt = await createAppointmentWithSession(patient, doctor, pkg, today, time);
            await createPaidPayment(apt, patient, doctor, pkg);
        }
        
        const report = await calculateDailyClosing(today);
        
        // 3 x 150 = 450
        expect(report.summary.financial.totalReceived).toBe(450);
        expect(report.timelines.payments).toHaveLength(3);
        expect(report.summary.appointments.attended).toBe(3);
    });
    
    it('apenas appointments COMPLETADOS aparecem no caixa', async () => {
        const { patient, doctor } = await seedData();
        const today = moment().format('YYYY-MM-DD');
        
        // 1 appointment completado (com payment)
        const aptCompleted = await createAppointmentWithSession(patient, doctor, null, today, '09:00');
        await createPaidPayment(aptCompleted, patient, doctor, null);
        
        // 1 appointment apenas agendado (sem payment)
        await Appointment.create({
            patient: patient._id,
            doctor: doctor._id,
            date: new Date(today + 'T12:00:00.000Z'),
            time: '10:00',
            duration: 40,
            specialty: 'fonoaudiologia',
            serviceType: 'evaluation',
            sessionValue: 200,
            paymentMethod: 'pix',
            operationalStatus: 'scheduled',
            clinicalStatus: 'pending',
            paymentStatus: 'pending',
            status: 'scheduled'
        });
        
        const report = await calculateDailyClosing(today);
        
        // Apenas o completado conta
        expect(report.summary.financial.totalReceived).toBe(160);
        expect(report.summary.appointments.attended).toBe(1);
        expect(report.summary.appointments.total).toBe(2);
    });
    
    it('payment.status=paid garante valor no caixa', async () => {
        const { patient, doctor } = await seedData();
        const today = moment().format('YYYY-MM-DD');
        
        const appointment = await createAppointmentWithSession(patient, doctor, null, today, '09:00');
        const payment = await createPaidPayment(appointment, patient, doctor, null);
        
        // Verifica payment
        expect(payment.status).toBe('paid');
        expect(payment.amount).toBe(160);
        
        // Verifica caixa
        const report = await calculateDailyClosing(today);
        
        // GARANTIA: Se payment está pago, valor está no caixa
        expect(report.summary.financial.totalReceived).toBe(payment.amount);
        expect(report.timelines.payments.some(p => p.id === payment._id.toString())).toBe(true);
    });
    
    it('diferentes métodos de pagamento são categorizados', async () => {
        const { patient, doctor } = await seedData();
        const today = moment().format('YYYY-MM-DD');
        
        const methods = [
            { method: 'dinheiro', value: 100 },
            { method: 'pix', value: 150 },
            { method: 'cartão', value: 200 }
        ];
        
        for (const { method, value } of methods) {
            const apt = await createAppointmentWithSession(patient, doctor, null, today, '09:00');
            apt.sessionValue = value;
            apt.paymentMethod = method;
            await apt.save();
            
            await Payment.create({
                patient: patient._id,
                doctor: doctor._id,
                appointment: apt._id,
                amount: value,
                paymentDate: new Date(),
                paymentMethod: method,
                status: 'paid',
                serviceType: 'session',
                kind: 'session_payment',
                billingType: 'particular',
                paidAt: new Date(),
                clinicId: 'default'
            });
        }
        
        const report = await calculateDailyClosing(today);
        
        // Total deve ser 450
        expect(report.summary.financial.totalReceived).toBe(450);
        
        // Deve ter 3 pagamentos
        expect(report.timelines.payments).toHaveLength(3);
    });
});

describe('🛡️ Proteção contra regressão', () => {
    
    it('se caixa está zerado, não deve haver payments pagos', async () => {
        const { patient, doctor } = await seedData();
        const today = moment().format('YYYY-MM-DD');
        
        // Não cria nada
        const report = await calculateDailyClosing(today);
        
        // Caixa deve estar zerado
        expect(report.summary.financial.totalReceived).toBe(0);
        expect(report.timelines.payments).toHaveLength(0);
        
        // Não deve haver payments
        const paymentsCount = await Payment.countDocuments({ status: 'paid' });
        expect(paymentsCount).toBe(0);
    });
    
    it('appointment cancelado não gera payment no caixa', async () => {
        const { patient, doctor } = await seedData();
        const today = moment().format('YYYY-MM-DD');
        
        // Cria appointment cancelado
        const appointment = await Appointment.create({
            patient: patient._id,
            doctor: doctor._id,
            date: new Date(today + 'T12:00:00.000Z'),
            time: '09:00',
            duration: 40,
            specialty: 'fonoaudiologia',
            serviceType: 'evaluation',
            sessionValue: 160,
            paymentMethod: 'pix',
            operationalStatus: 'canceled',
            clinicalStatus: 'canceled',
            paymentStatus: 'canceled',
            status: 'canceled'
        });
        
        // Cria um payment (simulando erro)
        await Payment.create({
            patient: patient._id,
            doctor: doctor._id,
            appointment: appointment._id,
            amount: 160,
            paymentDate: new Date(),
            paymentMethod: 'pix',
            status: 'canceled', // CANCELADO
            serviceType: 'session',
            kind: 'session_payment',
            billingType: 'particular',
            clinicId: 'default'
        });
        
        const report = await calculateDailyClosing(today);
        
        // Caixa deve estar zerado (apenas payments PAID contam)
        expect(report.summary.financial.totalReceived).toBe(0);
    });
});
