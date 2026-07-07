/**
 * Testes de regressão da SessionFactory — PR 2 (2026-07-07).
 *
 * Garante que Sessions de convênio/liminar nunca nasçam 'completed' por
 * herança de status. Consumo (guideConsumed, Payment, revenueRecognizedAt)
 * só pode acontecer via completeSessionV2 → ConvenioHandler/LiminarHandler.
 */
import { describe, it, expect } from 'vitest';
import {
    buildInsuranceSession,
    buildLiminarSession,
    buildSessionFromAppointment
} from '../sessionFactory.js';

const baseAppointment = {
    _id: 'appt-1',
    patient: 'patient-1',
    doctor: 'doctor-1',
    date: new Date('2026-07-10'),
    time: '10:00',
    specialty: 'terapia_ocupacional',
    sessionValue: 100
};

describe('buildInsuranceSession', () => {
    it('nasce scheduled por padrão', () => {
        const session = buildInsuranceSession(baseAppointment);
        expect(session.status).toBe('scheduled');
        expect(session.clinicalStatus).toBe('pending');
    });

    it('lança erro se tentarem criar já completed', () => {
        expect(() => buildInsuranceSession(baseAppointment, { status: 'completed' }))
            .toThrow(/INVALID_SESSION_FACTORY_STATUS/);
    });

    it('não herda status do objeto appointment mesmo se ele tiver status=completed', () => {
        // Simula o cenário do bug original: alguém espalha o appointment inteiro
        // (que tem seu próprio campo `status`/`operationalStatus`) como primeiro
        // argumento. status da Session só pode vir de `options`, nunca do appointment.
        const appointmentWithCompletedStatus = {
            ...baseAppointment,
            status: 'completed',
            operationalStatus: 'completed'
        };
        const session = buildInsuranceSession(appointmentWithCompletedStatus);
        expect(session.status).toBe('scheduled');
    });

    it('permite status explícito diferente de completed (ex: scheduled)', () => {
        const session = buildInsuranceSession(baseAppointment, { status: 'scheduled' });
        expect(session.status).toBe('scheduled');
    });
});

describe('buildLiminarSession', () => {
    it('nasce scheduled por padrão', () => {
        const session = buildLiminarSession(baseAppointment);
        expect(session.status).toBe('scheduled');
    });

    it('lança erro se tentarem criar já completed', () => {
        expect(() => buildLiminarSession(baseAppointment, { status: 'completed' }))
            .toThrow(/INVALID_SESSION_FACTORY_STATUS/);
    });
});

describe('buildSessionFromAppointment (base, sem guard — usado por particular/pacote)', () => {
    it('continua permitindo completed diretamente (fora do escopo do guard de convênio/liminar)', () => {
        const session = buildSessionFromAppointment(baseAppointment, { status: 'completed' });
        expect(session.status).toBe('completed');
    });
});
