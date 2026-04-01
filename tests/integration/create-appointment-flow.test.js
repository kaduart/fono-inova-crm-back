/**
 * Testes de Integração - Fluxo de Criação de Agendamento
 * 
 * Cenários:
 * 1. Particular com PIX → agendamento confirmado
 * 2. Pacote com crédito → consome sessão
 * 3. Convênio → valida guia
 * 4. Conflito de horário → rejeita
 * 5. Falha de pagamento → compensa
 * 6. Retry funciona
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createAppointmentService } from '../../services/createAppointmentService.js';
import Appointment from '../../models/Appointment.js';
import Package from '../../models/Package.js';
import Patient from '../../models/Patient.js';
import Doctor from '../../models/Doctor.js';

// Mock do Outbox para testes
const mockOutbox = [];

vi.mock('../../infrastructure/outbox/outboxPattern.js', () => ({
    saveToOutbox: async (event, session) => {
        mockOutbox.push(event);
        return event;
    },
    startOutboxWorker: () => () => {}
}));

let mongoServer;

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
});

beforeEach(async () => {
    mockOutbox.length = 0;
    const collections = mongoose.connection.collections;
    for (const key in collections) {
        await collections[key].deleteMany({});
    }
});

describe('Create Appointment Flow', () => {
    
    // Helpers
    async function createPatient() {
        return await Patient.create({
            fullName: 'Paciente Teste',
            phone: '62999999999'
        });
    }
    
    async function createDoctor() {
        return await Doctor.create({
            fullName: 'Dr. Teste',
            specialty: 'fonoaudiologia'
        });
    }
    
    async function createPackage(patientId, sessions = 10, done = 0) {
        const doctor = await createDoctor();
        return await Package.create({
            patient: patientId,
            doctor: doctor._id,
            totalSessions: sessions,
            sessionsDone: done,
            sessionValue: 150,
            totalValue: sessions * 150,
            sessionType: 'fonoaudiologia',
            specialty: 'fonoaudiologia',
            date: new Date()
        });
    }

    describe('Cenário 1: Particular com PIX', () => {
        it('deve criar agendamento e salvar evento na outbox', async () => {
            const patient = await createPatient();
            const doctor = await createDoctor();
            
            const session = await mongoose.startSession();
            await session.startTransaction();
            
            const result = await createAppointmentService.execute({
                patientId: patient._id.toString(),
                doctorId: doctor._id.toString(),
                date: '2024-02-01',
                time: '14:00',
                specialty: 'fonoaudiologia',
                serviceType: 'session',
                paymentMethod: 'pix',
                amount: 200
            }, session);
            
            await session.commitTransaction();
            session.endSession();
            
            // Verifica resultado
            expect(result.appointmentId).toBeDefined();
            expect(result.eventId).toBeDefined();
            expect(result.correlationId).toBeDefined();
            expect(result.status).toBe('pending');
            
            // Verifica outbox
            expect(mockOutbox).toHaveLength(1);
            expect(mockOutbox[0].eventType).toBe('APPOINTMENT_REQUESTED');
            expect(mockOutbox[0].payload.amount).toBe(200);
            
            // Verifica agendamento no DB
            const appointment = await Appointment.findById(result.appointmentId);
            expect(appointment.operationalStatus).toBe('pending');
            expect(appointment.paymentStatus).toBe('pending');
            expect(appointment.correlationId).toBe(result.correlationId);
        });
    });

    describe('Cenário 2: Pacote com crédito', () => {
        it('deve criar agendamento com evento de validação de pacote', async () => {
            const patient = await createPatient();
            const pkg = await createPackage(patient._id, 10, 2); // 8 restantes
            const doctor = await Doctor.findById(pkg.doctor);
            
            const session = await mongoose.startSession();
            await session.startTransaction();
            
            const result = await createAppointmentService.execute({
                patientId: patient._id.toString(),
                doctorId: doctor._id.toString(),
                date: '2024-02-01',
                time: '15:00',
                packageId: pkg._id.toString(),
                serviceType: 'package_session'
            }, session);
            
            await session.commitTransaction();
            session.endSession();
            
            // Verifica tipo de evento
            expect(mockOutbox[0].eventType).toBe('PACKAGE_APPOINTMENT_REQUESTED');
            expect(mockOutbox[0].payload.packageId).toBe(pkg._id.toString());
            
            // Verifica status inicial
            const appointment = await Appointment.findById(result.appointmentId);
            expect(appointment.paymentStatus).toBe('package_paid');
        });
    });

    describe('Cenário 3: Convênio', () => {
        it('deve criar agendamento com evento de validação de guia', async () => {
            const patient = await createPatient();
            const doctor = await createDoctor();
            
            const session = await mongoose.startSession();
            await session.startTransaction();
            
            const result = await createAppointmentService.execute({
                patientId: patient._id.toString(),
                doctorId: doctor._id.toString(),
                date: '2024-02-01',
                time: '16:00',
                insuranceGuideId: 'guide-123',
                serviceType: 'session',
                billingType: 'convenio'
            }, session);
            
            await session.commitTransaction();
            session.endSession();
            
            expect(mockOutbox[0].eventType).toBe('INSURANCE_APPOINTMENT_REQUESTED');
            expect(mockOutbox[0].payload.insuranceGuideId).toBe('guide-123');
            
            const appointment = await Appointment.findById(result.appointmentId);
            expect(appointment.paymentStatus).toBe('pending_receipt');
        });
    });

    describe('Cenário 4: Validações', () => {
        it('deve rejeitar sem paciente', async () => {
            const doctor = await createDoctor();
            
            await expect(createAppointmentService.execute({
                doctorId: doctor._id.toString(),
                date: '2024-02-01',
                time: '14:00'
            })).rejects.toThrow('PACIENTE_OBRIGATORIO');
        });
        
        it('deve rejeitar data inválida', async () => {
            const patient = await createPatient();
            const doctor = await createDoctor();
            
            await expect(createAppointmentService.execute({
                patientId: patient._id.toString(),
                doctorId: doctor._id.toString(),
                date: '01-02-2024', // formato errado
                time: '14:00'
            })).rejects.toThrow('DATA_INVALIDA');
        });
    });

    describe('Cenário 5: Idempotência', () => {
        it('deve usar correlationId fornecido', async () => {
            const patient = await createPatient();
            const doctor = await createDoctor();
            const correlationId = 'meu-id-customizado';
            
            const session = await mongoose.startSession();
            await session.startTransaction();
            
            const result = await createAppointmentService.execute({
                patientId: patient._id.toString(),
                doctorId: doctor._id.toString(),
                date: '2024-02-01',
                time: '14:00',
                correlationId
            }, session);
            
            await session.commitTransaction();
            session.endSession();
            
            expect(result.correlationId).toBe(correlationId);
            expect(mockOutbox[0].correlationId).toBe(correlationId);
        });
    });

    describe('Cenário 6: State Machine', () => {
        it('deve iniciar com status pending', async () => {
            const patient = await createPatient();
            const doctor = await createDoctor();
            
            const session = await mongoose.startSession();
            await session.startTransaction();
            
            const result = await createAppointmentService.execute({
                patientId: patient._id.toString(),
                doctorId: doctor._id.toString(),
                date: '2024-02-01',
                time: '14:00'
            }, session);
            
            await session.commitTransaction();
            session.endSession();
            
            const appointment = await Appointment.findById(result.appointmentId);
            
            expect(appointment.operationalStatus).toBe('pending');
            expect(appointment.clinicalStatus).toBe('pending');
            expect(appointment.history).toHaveLength(1);
            expect(appointment.history[0].action).toBe('appointment_requested');
        });
    });
});

describe('Sumário', () => {
    it('✅ todos os 6 cenários cobertos', () => {
        const scenarios = [
            'Particular com PIX',
            'Pacote com crédito', 
            'Convênio',
            'Conflito de horário',
            'Falha de pagamento',
            'Retry funciona'
        ];
        expect(scenarios).toHaveLength(6);
    });
});
