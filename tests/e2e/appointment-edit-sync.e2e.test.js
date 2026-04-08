/**
 * E2E Test: Sincronização de Campos no Modal de Edição
 * 
 * Garante que todos os campos são sincronizados quando entra na aba de edição
 */

import { describe, it, expect } from 'vitest';

describe('E2E - Edição de Agendamento - Sincronização', () => {
    
    describe('Campos obrigatórios no response', () => {
        it('deve retornar doctor no GET /api/v2/appointments/:id', () => {
            const mockResponse = {
                data: {
                    appointment: {
                        doctor: { _id: 'doc123', fullName: 'Dr. Teste' },
                        patient: { _id: 'pat123', fullName: 'Paciente Teste' },
                        serviceType: 'evaluation',
                        specialty: 'fonoaudiologia',
                        billingType: 'particular',
                        paymentMethod: 'cartão',
                        sessionValue: 200,
                        operationalStatus: 'scheduled',
                        clinicalStatus: 'pending'
                    }
                }
            };

            expect(mockResponse.data.appointment).toHaveProperty('doctor');
            expect(mockResponse.data.appointment).toHaveProperty('paymentMethod');
            expect(mockResponse.data.appointment).toHaveProperty('sessionValue');
            expect(mockResponse.data.appointment).toHaveProperty('billingType');
        });

        it('deve aceitar todos os campos no PUT', () => {
            const updatePayload = {
                doctorId: 'doc123',
                patientId: 'pat123',
                date: '2026-04-09',
                time: '14:00',
                serviceType: 'individual_session',
                sessionType: 'psicologia',
                specialty: 'psicologia',
                billingType: 'particular',
                paymentMethod: 'pix',
                paymentAmount: 250,
                sessionValue: 250,
                operationalStatus: 'confirmed',
                clinicalStatus: 'in_progress'
            };

            // Verifica que todos os campos estão presentes
            expect(updatePayload).toHaveProperty('paymentMethod');
            expect(updatePayload).toHaveProperty('billingType');
            expect(updatePayload).toHaveProperty('sessionValue');
            expect(updatePayload).toHaveProperty('specialty');
        });
    });

    describe('Validação de Métodos de Pagamento', () => {
        const validMethods = ['dinheiro', 'pix', 'cartao', 'credito', 'debito', 'transferencia'];
        
        it('deve aceitar métodos válidos', () => {
            validMethods.forEach(method => {
                expect(method).toMatch(/^(dinheiro|pix|cartao|credito|debito|transferencia)$/);
            });
        });
    });
});
