/**
 * Testes de Integração - appointmentHybridService.create()
 *
 * Cobre a regressão em que o HybridService montava o Appointment a partir de uma
 * whitelist fixa e descartava silenciosamente campos preenchidos no agendamento,
 * além de sobrescrever o operationalStatus com um 'pending' hardcoded.
 *
 * Asserções feitas contra o BANCO (re-leitura via findById), não contra o retorno
 * em memória — o bug original passava despercebido justamente porque a criação
 * respondia 201 com o documento aparentemente correto.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import Appointment from '../../models/Appointment.js';
import Patient from '../../models/Patient.js';
import Doctor from '../../models/Doctor.js';

vi.mock('../../infrastructure/outbox/outboxPattern.js', () => ({
    saveToOutbox: async (event) => event
}));

vi.mock('../../infrastructure/outbox/OutboxDispatcher.js', () => ({
    startOutboxDispatcher: () => () => {}
}));

const { appointmentHybridService } = await import('../../services/appointmentHybridService.js');

let mongoServer;

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
}, 30000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
}, 15000);

beforeEach(async () => {
    const collections = mongoose.connection.collections;
    for (const key in collections) {
        await collections[key].deleteMany({});
    }
});

async function seed() {
    const patient = await Patient.create({
        fullName: 'Júlia Prado Souza',
        phone: '62991805470',
        dateOfBirth: new Date('2026-07-30T00:00:00.000Z')
    });

    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const doctor = await Doctor.create({
        fullName: 'Lorrany Siqueira Marques',
        specialty: 'fonoaudiologia',
        email: `lorrany.${suffix}@test.com`,
        licenseNumber: `CRM-${suffix.toUpperCase()}`,
        phoneNumber: '(61) 99240-0846'
    });

    return { patient, doctor };
}

function baseInput({ patient, doctor }, overrides = {}) {
    return {
        patientId: patient._id,
        doctorId: doctor._id,
        date: new Date('2026-08-10T12:00:00.000Z'),
        time: '14:00',
        specialty: 'fonoaudiologia',
        serviceType: 'tongue_tie_test',
        billingType: 'particular',
        paymentMethod: 'pix',
        amount: 160,
        ...overrides
    };
}

describe('appointmentHybridService.create — persistência de campos', () => {

    it('persiste responsible, sessionType, metadata.origin e preferredPeriod', async () => {
        const ctx = await seed();

        const result = await appointmentHybridService.create(baseInput(ctx, {
            responsible: 'Raquel',
            sessionType: 'fonoaudiologia',
            preferredPeriod: 'tarde',
            metadata: { origin: { source: 'web_app' } }
        }), undefined);

        const saved = await Appointment.findById(result.appointmentId).lean();

        expect(saved.responsible).toBe('Raquel');
        expect(saved.sessionType).toBe('fonoaudiologia');
        expect(saved.preferredPeriod).toBe('tarde');
        expect(saved.metadata.origin.source).toBe('web_app');
    });

    it('persiste patientInfo.birthDate quando o snapshot chega com a chave birthDate', async () => {
        const ctx = await seed();

        // createAppointmentCommand monta o snapshot com `birthDate`; o model Patient
        // usa `dateOfBirth`. Ler só um dos dois zerava a data.
        const result = await appointmentHybridService.create(baseInput(ctx, {
            patientInfo: {
                fullName: 'Júlia Prado Souza',
                phone: '62991805470',
                birthDate: new Date('2026-07-30T00:00:00.000Z'),
                email: null
            }
        }), undefined);

        const saved = await Appointment.findById(result.appointmentId).lean();

        // O schema tipa patientInfo.birthDate como String. Entregar um Date fazia o
        // Mongoose stringificar no fuso local e recuar a data em um dia
        // ("Wed Jul 29 2026 21:00:00 GMT-0300"). Contrato: YYYY-MM-DD em UTC.
        expect(saved.patientInfo.birthDate).toBe('2026-07-30');
    });

    it('normaliza birthDate vindo como string YYYY-MM-DD sem alterar o dia', async () => {
        const ctx = await seed();

        const result = await appointmentHybridService.create(baseInput(ctx, {
            patientInfo: {
                fullName: 'Júlia Prado Souza',
                phone: '62991805470',
                birthDate: '2026-07-30',
                email: null
            }
        }), undefined);

        const saved = await Appointment.findById(result.appointmentId).lean();

        expect(saved.patientInfo.birthDate).toBe('2026-07-30');
    });

    it('persiste dados de convênio', async () => {
        const ctx = await seed();

        const result = await appointmentHybridService.create(baseInput(ctx, {
            billingType: 'convenio',
            insuranceProvider: 'unimed-anapolis',
            insuranceValue: 80,
            authorizationCode: 'AUT-12345'
        }), undefined);

        const saved = await Appointment.findById(result.appointmentId).lean();

        expect(saved.insuranceProvider).toBe('unimed-anapolis');
        expect(saved.insuranceValue).toBe(80);
        expect(saved.authorizationCode).toBe('AUT-12345');
    });
});

describe('appointmentHybridService.create — operationalStatus inicial', () => {

    it('nasce pre_agendado quando nenhum status é informado', async () => {
        const ctx = await seed();

        const result = await appointmentHybridService.create(baseInput(ctx), undefined);
        const saved = await Appointment.findById(result.appointmentId).lean();

        expect(saved.operationalStatus).toBe('pre_agendado');
        expect(saved.history[0].newStatus).toBe('pre_agendado');
    });

    it('respeita pre_agendado enviado explicitamente', async () => {
        const ctx = await seed();

        const result = await appointmentHybridService.create(
            baseInput(ctx, { operationalStatus: 'pre_agendado' }), undefined
        );
        const saved = await Appointment.findById(result.appointmentId).lean();

        expect(saved.operationalStatus).toBe('pre_agendado');
        expect(saved.history[0].newStatus).toBe('pre_agendado');
    });

    it('respeita scheduled — front do CRM cria sessão de pacote já agendada', async () => {
        const ctx = await seed();

        const result = await appointmentHybridService.create(
            baseInput(ctx, { operationalStatus: 'scheduled' }), undefined
        );
        const saved = await Appointment.findById(result.appointmentId).lean();

        expect(saved.operationalStatus).toBe('scheduled');
        expect(saved.history[0].newStatus).toBe('scheduled');
    });

    it('cai em pre_agendado quando o status recebido não é estado de entrada', async () => {
        const ctx = await seed();

        // 'completed' é estado terminal: não pode ser ponto de partida.
        const result = await appointmentHybridService.create(
            baseInput(ctx, { operationalStatus: 'completed' }), undefined
        );
        const saved = await Appointment.findById(result.appointmentId).lean();

        expect(saved.operationalStatus).toBe('pre_agendado');
    });
});

describe('appointmentHybridService.create — guardas', () => {

    it('descarta sessionType fora do enum sem derrubar a criação', async () => {
        const ctx = await seed();

        const result = await appointmentHybridService.create(
            baseInput(ctx, { sessionType: 'especialidade_inexistente' }), undefined
        );
        const saved = await Appointment.findById(result.appointmentId).lean();

        expect(saved).toBeTruthy();
        expect(saved.sessionType).toBeNull();
    });

    it('mantém os defaults do schema quando os campos opcionais não são enviados', async () => {
        const ctx = await seed();

        const result = await appointmentHybridService.create(baseInput(ctx), undefined);
        const saved = await Appointment.findById(result.appointmentId).lean();

        expect(saved.responsible).toBe('');
        expect(saved.sessionType).toBeNull();
        expect(saved.metadata.origin.source).toBe('outro');
    });
});
