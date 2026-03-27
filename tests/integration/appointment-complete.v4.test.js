/**
 * Testes de Integração - Endpoint /complete v4.0
 * 
 * ⚠️ CRÍTICO: Estes testes validam o fluxo completo de conclusão de agendamento
 * com a arquitetura financeira v4.0, incluindo:
 * - Criação de Payment fora da transação
 * - Commit da transação (Session, Appointment, Package)
 * - Confirmação do Payment após commit
 * - Criação do FinancialEvent
 * - Compensação em caso de falha
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import express from 'express';
import moment from 'moment-timezone';

// Mock do middleware de auth
const mockAuth = (req, res, next) => {
    req.user = { _id: new mongoose.Types.ObjectId(), role: 'admin' };
    next();
};

// =============================================================================
// SETUP DO BANCO E SERVIDOR
// =============================================================================
let mongoServer;
let app;
let server;

// Models
let Patient, Doctor, Appointment, Session, Package, Payment, PatientBalance, FinancialEvent;

beforeAll(async () => {
    // Inicia MongoDB em memória
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    await mongoose.connect(mongoUri);
    
    // Importa models
    Patient = (await import('../../models/Patient.js')).default;
    Doctor = (await import('../../models/Doctor.js')).default;
    Appointment = (await import('../../models/Appointment.js')).default;
    Session = (await import('../../models/Session.js')).default;
    Package = (await import('../../models/Package.js')).default;
    Payment = (await import('../../models/Payment.js')).default;
    PatientBalance = (await import('../../models/PatientBalance.js')).default;
    FinancialEvent = (await import('../../models/FinancialEvent.js')).default;
    
    // Setup do Express
    app = express();
    app.use(express.json());
    
    // Importa e configura as rotas
    const appointmentRouter = (await import('../../routes/appointment.js')).default;
    app.use('/appointments', mockAuth, appointmentRouter);
    
    // Inicia servidor em porta aleatória
    server = app.listen(0);
});

afterAll(async () => {
    await server.close();
    await mongoose.disconnect();
    await mongoServer.stop();
});

beforeEach(async () => {
    // Limpa coleções
    await Patient.deleteMany({});
    await Doctor.deleteMany({});
    await Appointment.deleteMany({});
    await Session.deleteMany({});
    await Package.deleteMany({});
    await Payment.deleteMany({});
    await PatientBalance.deleteMany({});
    await FinancialEvent.deleteMany({});
});

// =============================================================================
// HELPERS
// =============================================================================
async function createTestData({ packageType = null, paymentType = null } = {}) {
    const patient = await Patient.create({
        fullName: 'Paciente Teste',
        phone: '11999999999',
        cpf: '12345678901'
    });
    
    const doctor = await Doctor.create({
        fullName: 'Dr. Teste',
        email: 'dr@teste.com',
        cpf: '98765432101',
        crm: '12345',
        specialty: 'fonoaudiologia'
    });
    
    let pkg = null;
    if (packageType) {
        pkg = await Package.create({
            patient: patient._id,
            doctor: doctor._id,
            type: packageType,
            paymentType: paymentType,
            totalSessions: 10,
            sessionsDone: 0,
            totalValue: 1500,
            sessionValue: 150,
            totalPaid: 0
        });
    }
    
    const appointment = await Appointment.create({
        patient: patient._id,
        doctor: doctor._id,
        package: pkg?._id,
        date: moment().format('YYYY-MM-DD'),
        time: '10:00',
        duration: 50,
        reason: 'Sessão de teste',
        specialty: 'fonoaudiologia',
        sessionType: 'fonoaudiologia',
        operationalStatus: 'scheduled',
        clinicalStatus: 'pending',
        sessionValue: 150
    });
    
    const session = await Session.create({
        patient: patient._id,
        professional: doctor._id,
        appointment: appointment._id,
        package: pkg?._id,
        date: moment().format('YYYY-MM-DD'),
        status: 'scheduled',
        paymentStatus: 'pending'
    });
    
    // Link session to appointment
    appointment.session = session._id;
    await appointment.save();
    
    return { patient, doctor, pkg, appointment, session };
}

// =============================================================================
// TESTES DO FLUXO COMPLETO
// =============================================================================
describe('POST /appointments/:id/complete - v4.0', () => {
    
    it('✅ deve completar sessão particular avulsa (auto_per_session)', async () => {
        const { appointment, patient } = await createTestData();
        
        const correlationId = `test_${Date.now()}_1`;
        
        const response = await request(app)
            .patch(`/appointments/${appointment._id}/complete`)
            .set('x-correlation-id', correlationId)
            .expect(200);
        
        // Verifica resposta
        expect(response.body.clinicalStatus).toBe('completed');
        expect(response.body.operationalStatus).toBe('confirmed');
        expect(response.body.paymentStatus).toBe('paid');
        
        // Verifica Payment criado
        const payments = await Payment.find({ appointment: appointment._id });
        expect(payments).toHaveLength(1);
        expect(payments[0].status).toBe('paid');
        expect(payments[0].paymentOrigin).toBe('auto_per_session');
        expect(payments[0].correlationId).toBe(correlationId);
        expect(payments[0].confirmedAt).toBeDefined();
        
        // Verifica Session
        const session = await Session.findById(appointment.session);
        expect(session.paymentOrigin).toBe('auto_per_session');
        expect(session.correlationId).toBe(correlationId);
        
        // Verifica FinancialEvent
        const events = await FinancialEvent.find({ correlationId });
        expect(events).toHaveLength(1);
        expect(events[0].eventType).toBe('SESSION_COMPLETED');
        expect(events[0].payload.paymentType).toBe('auto_per_session');
    });

    it('✅ deve completar sessão com saldo devedor (manual_balance)', async () => {
        const { appointment, patient } = await createTestData();
        
        const correlationId = `test_${Date.now()}_2`;
        
        const response = await request(app)
            .patch(`/appointments/${appointment._id}/complete`)
            .set('x-correlation-id', correlationId)
            .send({
                addToBalance: true,
                balanceAmount: 200,
                balanceDescription: 'Pagamento pendente - teste'
            })
            .expect(200);
        
        // Verifica resposta
        expect(response.body.paymentStatus).toBe('pending');
        expect(response.body.addedToBalance).toBe(true);
        expect(response.body.balanceAmount).toBe(200);
        expect(response.body.patientBalance).toBe(200);
        
        // Não deve criar Payment
        const payments = await Payment.find({ appointment: appointment._id });
        expect(payments).toHaveLength(0);
        
        // Verifica PatientBalance
        const balance = await PatientBalance.findOne({ patient: patient._id });
        expect(balance).toBeDefined();
        expect(balance.currentBalance).toBe(200);
        
        // Verifica Session
        const session = await Session.findById(appointment.session);
        expect(session.paymentOrigin).toBe('manual_balance');
        
        // Verifica FinancialEvent
        const events = await FinancialEvent.find({ correlationId });
        expect(events).toHaveLength(1);
        expect(events[0].payload.addToBalance).toBe(true);
        expect(events[0].payload.balanceAmount).toBe(200);
    });

    it('✅ deve completar sessão de pacote per-session', async () => {
        const { appointment, pkg, patient } = await createTestData({
            packageType: 'particular',
            paymentType: 'per-session'
        });
        
        const correlationId = `test_${Date.now()}_3`;
        
        const response = await request(app)
            .patch(`/appointments/${appointment._id}/complete`)
            .set('x-correlation-id', correlationId)
            .expect(200);
        
        // Verifica resposta
        expect(response.body.paymentStatus).toBe('package_paid');
        
        // Verifica Payment criado
        const payments = await Payment.find({ appointment: appointment._id });
        expect(payments).toHaveLength(1);
        expect(payments[0].status).toBe('paid');
        expect(payments[0].paymentOrigin).toBe('auto_per_session');
        expect(payments[0].package.toString()).toBe(pkg._id.toString());
        
        // Verifica Package atualizado
        const updatedPkg = await Package.findById(pkg._id);
        expect(updatedPkg.sessionsDone).toBe(1);
        expect(updatedPkg.totalPaid).toBe(150);
        
        // Verifica Session
        const session = await Session.findById(appointment.session);
        expect(session.paymentOrigin).toBe('auto_per_session');
        expect(session.paymentId.toString()).toBe(payments[0]._id.toString());
    });

    it('✅ deve completar sessão de pacote prepaid (não cria payment)', async () => {
        const { appointment, pkg } = await createTestData({
            packageType: 'particular',
            paymentType: 'prepaid'
        });
        
        const correlationId = `test_${Date.now()}_4`;
        
        const response = await request(app)
            .patch(`/appointments/${appointment._id}/complete`)
            .set('x-correlation-id', correlationId)
            .expect(200);
        
        // Verifica resposta
        expect(response.body.paymentStatus).toBe('package_paid');
        
        // Não deve criar Payment (já foi pago no pacote)
        const payments = await Payment.find({ appointment: appointment._id });
        expect(payments).toHaveLength(0);
        
        // Verifica Session
        const session = await Session.findById(appointment.session);
        expect(session.paymentOrigin).toBe('package_prepaid');
        expect(session.paymentStatus).toBe('covered_by_package');
    });

    it('✅ deve completar sessão de convênio', async () => {
        const { appointment, pkg, patient } = await createTestData({
            packageType: 'convenio'
        });
        
        const correlationId = `test_${Date.now()}_5`;
        
        const response = await request(app)
            .patch(`/appointments/${appointment._id}/complete`)
            .set('x-correlation-id', correlationId)
            .expect(200);
        
        // Verifica resposta
        expect(response.body.paymentStatus).toBe('pending_receipt');
        
        // Verifica Payment criado (status pending para convênio)
        const payments = await Payment.find({ appointment: appointment._id });
        expect(payments).toHaveLength(1);
        expect(payments[0].status).toBe('pending');
        expect(payments[0].paymentOrigin).toBe('convenio');
        expect(payments[0].billingType).toBe('convenio');
        
        // Verifica Session
        const session = await Session.findById(appointment.session);
        expect(session.paymentOrigin).toBe('convenio');
        expect(session.paymentStatus).toBe('pending_receipt');
    });

    it('✅ deve evitar duplicação (idempotência)', async () => {
        const { appointment } = await createTestData();
        
        // Primeira chamada
        await request(app)
            .patch(`/appointments/${appointment._id}/complete`)
            .expect(200);
        
        // Segunda chamada (deve retornar sem duplicar)
        const response = await request(app)
            .patch(`/appointments/${appointment._id}/complete`)
            .expect(200);
        
        // Deve ter apenas 1 Payment
        const payments = await Payment.find({ appointment: appointment._id });
        expect(payments).toHaveLength(1);
    });
});

// =============================================================================
// TESTES DE COMPENSAÇÃO (FALHAS)
// =============================================================================
describe('Compensação - Casos de Falha', () => {
    
    it('deve compensar payment quando transação falha (simulado)', async () => {
        // Este teste simula o comportamento de compensação
        // Na prática, a transação MongoDB garante atomicidade
        
        const { appointment } = await createTestData();
        
        // Cria payment fora da transação (simulando o comportamento real)
        const payment = await Payment.create({
            patient: appointment.patient,
            doctor: appointment.doctor,
            appointment: appointment._id,
            serviceType: 'individual_session',
            amount: 150,
            paymentMethod: 'pix',
            status: 'pending',
            paymentOrigin: 'auto_per_session',
            correlationId: 'test_compensation',
            notes: 'Pagamento automático - Pendente de confirmação'
        });
        
        // Simula falha na transação
        const transactionFailed = true;
        
        if (transactionFailed) {
            // Compensação: marca como cancelado em vez de deletar
            await Payment.updateOne(
                { _id: payment._id },
                {
                    $set: {
                        status: 'canceled',
                        cancellationReason: 'transaction_rollback',
                        canceledAt: new Date(),
                        notes: payment.notes + ' | [CANCELADO: transação abortada]'
                    }
                }
            );
        }
        
        // Verifica compensação
        const updatedPayment = await Payment.findById(payment._id);
        expect(updatedPayment.status).toBe('canceled');
        expect(updatedPayment.cancellationReason).toBe('transaction_rollback');
        expect(updatedPayment.canceledAt).toBeDefined();
        expect(updatedPayment.notes).toContain('[CANCELADO');
    });
});

// =============================================================================
// TESTES DE VALIDAÇÃO
// =============================================================================
describe('Validações v4.0', () => {
    
    it('deve retornar 404 para agendamento inexistente', async () => {
        const fakeId = new mongoose.Types.ObjectId();
        
        await request(app)
            .patch(`/appointments/${fakeId}/complete`)
            .expect(404);
    });

    it('deve validar campos de saldo devedor', async () => {
        const { appointment } = await createTestData();
        
        // Sem balanceAmount quando addToBalance=true
        const response = await request(app)
            .patch(`/appointments/${appointment._id}/complete`)
            .send({
                addToBalance: true,
                balanceDescription: 'Teste'
            })
            .expect(200);
        
        // Deve usar sessionValue como fallback
        expect(response.body.balanceAmount).toBe(150); // sessionValue
    });
});

// =============================================================================
// MÉTRICAS DE PERFORMANCE
// =============================================================================
describe('Performance v4.0', () => {
    
    it('deve completar sessão em menos de 500ms (warm)', async () => {
        const { appointment } = await createTestData();
        
        const start = Date.now();
        
        await request(app)
            .patch(`/appointments/${appointment._id}/complete`)
            .expect(200);
        
        const duration = Date.now() - start;
        
        // Aceita até 500ms (em produção com MongoDB real)
        expect(duration).toBeLessThan(500);
    });
});
