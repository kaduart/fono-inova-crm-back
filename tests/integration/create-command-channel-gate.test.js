/**
 * Testes - createAppointmentCommand: restrição de status inicial por CANAL
 *
 * Cobre a fronteira introduzida junto do fix do operationalStatus:
 *
 *   isAgendaService ? 'pre_agendado' : payload.operationalStatus
 *
 * A Agenda Externa é canal de primeiro contato e não pode pular etapas; o front do
 * CRM (bookingService / packageService) e a Amanda criam agendamento já fechado e
 * mantêm o status que enviam.
 *
 * Aqui se testa a DECISÃO, capturando o que chega ao appointmentHybridService.
 * A PERSISTÊNCIA do que foi decidido é coberta por hybrid-create-fields.test.js.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Registram os schemas usados no populate da releitura pós-commit.
import '../../models/Patient.js';
import '../../models/Doctor.js';
import '../../models/Appointment.js';

// O command relê o Appointment depois do commit, então o dublê precisa persistir
// um documento real — devolver um ObjectId solto faria o command lançar
// "Agendamento criado, mas não encontrado após o commit".
const hybridCreateSpy = vi.fn(async (data) => {
    const { default: Appointment } = await import('../../models/Appointment.js');
    const doc = await Appointment.create({
        patient: data.patientId,
        doctor: data.doctorId,
        date: data.date,
        time: data.time,
        specialty: data.specialty,
        serviceType: data.serviceType,
        ...(data.operationalStatus ? { operationalStatus: data.operationalStatus } : {})
    });
    return { appointmentId: doc._id, sessionId: null, paymentId: null };
});

const billingHandleSpy = vi.fn(async () => ({ success: true, message: 'ok' }));

vi.mock('../../services/appointmentHybridService.js', () => ({
    appointmentHybridService: { create: (...args) => hybridCreateSpy(...args) }
}));

vi.mock('../../services/billing/BillingOrchestrator.js', () => ({
    default: { handleBilling: (...args) => billingHandleSpy(...args) }
}));

// A transação real exige replica set; aqui o alvo é a decisão, não a atomicidade.
vi.mock('../../utils/transactionRetry.js', () => ({
    runTransactionWithRetry: async (op) => op(null)
}));

vi.mock('../../services/appointment/helpers/leadHelper.js', () => ({
    ensureLeadForAppointment: async () => null,
    buildLeadSnapshot: async () => null
}));

vi.mock('../../services/appointment/policies/appointmentSpecialtyPolicy.js', () => ({
    validateDoctorSpecialty: async () => true
}));

vi.mock('../../services/appointment/helpers/socketHelper.js', () => ({
    emitSocket: () => {}
}));

vi.mock('../../services/auditLogService.js', () => ({
    recordAudit: async () => {}
}));

vi.mock('../../infrastructure/outbox/outboxPattern.js', () => ({
    saveToOutbox: async (e) => e
}));

const createAppointmentCommand = (
    await import('../../services/appointment/commands/createAppointmentCommand.js')
).default;

const AGENDA_USER = { id: 'agenda-service', role: 'admin', isService: true };
const AMANDA_USER = { id: 'amanda-service', role: 'admin', isService: true };
const CRM_USER = { _id: new mongoose.Types.ObjectId(), role: 'admin' };

function payload(overrides = {}) {
    return {
        patientId: new mongoose.Types.ObjectId().toString(),
        doctorId: new mongoose.Types.ObjectId().toString(),
        date: '2026-08-10',
        time: '14:00',
        specialty: 'fonoaudiologia',
        serviceType: 'individual_session',
        billingType: 'particular',
        paymentMethod: 'pix',
        paymentAmount: 160,
        ...overrides
    };
}

/** operationalStatus efetivamente entregue ao HybridService */
function statusHandedToHybrid() {
    expect(hybridCreateSpy).toHaveBeenCalledTimes(1);
    return hybridCreateSpy.mock.calls[0][0].operationalStatus;
}

function dataHandedToHybrid() {
    expect(hybridCreateSpy).toHaveBeenCalledTimes(1);
    return hybridCreateSpy.mock.calls[0][0];
}

// Os models não estão todos mockados; sem conexão o mongoose bufferiza e o teste trava.
let mongoServer;

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
}, 30000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
}, 15000);

beforeEach(() => {
    hybridCreateSpy.mockClear();
    billingHandleSpy.mockClear();
});

describe('createAppointmentCommand — status inicial por canal', () => {

    it('convênio da Agenda também força pre_agendado e preserva clientFields', async () => {
        const clientFields = { responsible: 'Raquel', preferredPeriod: 'tarde' };

        await createAppointmentCommand.execute(payload({
            billingType: 'convenio',
            operationalStatus: 'scheduled',
            clientFields,
        }), AGENDA_USER);

        expect(billingHandleSpy).toHaveBeenCalledOnce();
        expect(billingHandleSpy.mock.calls[0][0]).toMatchObject({
            operationalStatus: 'pre_agendado',
            clientFields,
        });
        expect(hybridCreateSpy).not.toHaveBeenCalled();
    });

    it('convênio do CRM mantém scheduled', async () => {
        await createAppointmentCommand.execute(payload({
            billingType: 'convenio',
            operationalStatus: 'scheduled',
        }), CRM_USER);

        expect(billingHandleSpy.mock.calls[0][0].operationalStatus).toBe('scheduled');
    });

    it('repassa o contrato único de campos simples ao HybridService', async () => {
        const clientFields = {
            responsible: 'Raquel',
            sessionType: 'fonoaudiologia',
            preferredPeriod: 'tarde',
            metadata: { origin: { source: 'agenda_externa' } },
            insuranceProvider: 'unimed-anapolis',
            insuranceValue: 80,
            authorizationCode: 'AUT-123',
        };

        // Os campos existem apenas no envelope: prova que o command não depende
        // mais de uma lista top-level duplicada no frontend.
        await createAppointmentCommand.execute(payload({ clientFields }), CRM_USER);

        expect(dataHandedToHybrid()).toMatchObject(clientFields);
    });

    it('agenda-service: força pre_agendado mesmo pedindo scheduled', async () => {
        await createAppointmentCommand.execute(
            payload({ operationalStatus: 'scheduled' }), AGENDA_USER
        );

        expect(statusHandedToHybrid()).toBe('pre_agendado');
    });

    it('agenda-service: força pre_agendado mesmo pedindo confirmed', async () => {
        await createAppointmentCommand.execute(
            payload({ operationalStatus: 'confirmed' }), AGENDA_USER
        );

        expect(statusHandedToHybrid()).toBe('pre_agendado');
    });

    it('amanda-service: mantém scheduled — horário já negociado no WhatsApp', async () => {
        await createAppointmentCommand.execute(
            payload({ operationalStatus: 'scheduled' }), AMANDA_USER
        );

        expect(statusHandedToHybrid()).toBe('scheduled');
    });

    it('usuário do CRM: mantém scheduled — sessão de pacote não é interesse', async () => {
        await createAppointmentCommand.execute(
            payload({ operationalStatus: 'scheduled' }), CRM_USER
        );

        expect(statusHandedToHybrid()).toBe('scheduled');
    });

    it('usuário do CRM sem status: deixa o HybridService aplicar o default do domínio', async () => {
        await createAppointmentCommand.execute(payload(), CRM_USER);

        expect(statusHandedToHybrid()).toBeUndefined();
    });

    it('agenda-service sem status: pre_agendado explícito', async () => {
        await createAppointmentCommand.execute(payload(), AGENDA_USER);

        expect(statusHandedToHybrid()).toBe('pre_agendado');
    });

    it('não confunde outro service token com a Agenda', async () => {
        await createAppointmentCommand.execute(
            payload({ operationalStatus: 'scheduled' }),
            { id: 'outro-service', role: 'admin', isService: true }
        );

        expect(statusHandedToHybrid()).toBe('scheduled');
    });
});
