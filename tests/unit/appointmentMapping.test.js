import { describe, it, expect } from 'vitest';
import {
    getSafePatientName,
    mapAppointmentToEvent,
    mapPreAgendamentoToEvent,
    getFriendlyStatus
} from '../../utils/appointmentMapper.js';

describe('AppointmentMapper - Unit Tests', () => {

    describe('getSafePatientName', () => {
        it('should return fullName if patient is an object', () => {
            expect(getSafePatientName({ patient: { fullName: 'Alice Obj' } })).toBe('Alice Obj');
        });

        it('should return fullName from patientInfo', () => {
            expect(getSafePatientName({ patientInfo: { fullName: 'Alice Info' } })).toBe('Alice Info');
        });

        it('should return patientName from root', () => {
            expect(getSafePatientName({ patientName: 'Alice Root' })).toBe('Alice Root');
        });

        it('should return patient if it is a string', () => {
            expect(getSafePatientName({ patient: 'Alice String' })).toBe('Alice String');
        });

        it('should return fallback if nothing is found', () => {
            expect(getSafePatientName({})).toBe('Paciente Desconhecido');
        });
    });

    describe('getSafeProfessionalName', () => {
        it('should return fullName if doctor is an object', () => {
            expect(getSafeProfessionalName({ doctor: { fullName: 'Dr. Obj' } })).toBe('Dr. Obj');
        });

        it('should return professionalName from root', () => {
            expect(getSafeProfessionalName({ professionalName: 'Dr. ProfName' })).toBe('Dr. ProfName');
        });

        it('should return professional string from root', () => {
            expect(getSafeProfessionalName({ professional: 'Dr. String' })).toBe('Dr. String');
        });

        it('should return fallback if nothing is found', () => {
            expect(getSafeProfessionalName({})).toBe('Profissional Desconhecido');
        });
    });

    describe('getFriendlyStatus', () => {
        it('should map scheduled/pending to Pendente', () => {
            expect(getFriendlyStatus('scheduled')).toBe('Pendente');
            expect(getFriendlyStatus('pending')).toBe('Pendente');
        });

        it('should map confirmed/paid to Confirmado', () => {
            expect(getFriendlyStatus('confirmed')).toBe('Confirmado');
            expect(getFriendlyStatus('paid')).toBe('Confirmado');
        });

        it('should map canceled to Cancelado', () => {
            expect(getFriendlyStatus('canceled')).toBe('Cancelado');
        });
    });

    describe('mapAppointmentToEvent', () => {
        it('should correctly map a full appointment object', () => {
            const mockAppt = {
                _id: '507f1f77bcf86cd799439011',
                date: '2026-02-16',
                time: '14:00',
                duration: 40,
                operationalStatus: 'scheduled',
                specialty: 'psicologia',
                notes: 'Teste de Mapeamento',
                doctor: { fullName: 'Dr. Teste' },
                patient: { fullName: 'Alice Marques Martins', phone: '11999999999' }
            };

            const event = mapAppointmentToEvent(mockAppt);

            expect(event.id).toBe('507f1f77bcf86cd799439011');
            expect(event.patientName).toBe('Alice Marques Martins');
            expect(event.professional).toBe('Dr. Teste');
            expect(event.status).toBe('Pendente');
            expect(event.patient.fullName).toBe('Alice Marques Martins');
        });
    });

    describe('mapPreAgendamentoToEvent', () => {
        it('should correctly map an interest (pre-appointment)', () => {
            const mockPre = {
                _id: '607f1f77bcf86cd799439022',
                preferredDate: '2026-02-17',
                preferredTime: '10:00',
                status: 'novo',
                specialty: 'fonoaudiologia',
                patientInfo: { fullName: 'Alice Marques Martins', phone: '11888888888' },
                professionalName: 'Dra. Suzane'
            };

            const event = mapPreAgendamentoToEvent(mockPre);

            expect(event.id).toBe('607f1f77bcf86cd799439022');
            expect(event.__isPreAgendamento).toBe(true);
            expect(event.patientName).toBe('Alice Marques Martins');
            expect(event.professional).toBe('Dra. Suzane');
            expect(event.status).toBe('Pendente');
        });
    });
});
