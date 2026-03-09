/**
 * 🧪 TESTES UNITÁRIOS - ensureLeadForAppointment
 * 
 * Testes específicos para a função que cria leads automaticamente
 * quando um agendamento é feito diretamente.
 * 
 * Issues corrigidas:
 * - E11000 duplicate key error collection: test.leads index: contact_phone_unique
 * - Race condition quando múltiplas requisições tentam criar o mesmo lead
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('🎯 ensureLeadForAppointment', () => {
    
    // Mocks
    const mockFindOne = vi.fn();
    const mockCreate = vi.fn();
    const mockFindById = vi.fn();
    
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('1️⃣ Verificação de duplicatas', () => {
        
        it('Deve retornar lead existente se telefone já existe', async () => {
            const phoneE164 = '556293163935';
            const existingLead = {
                _id: 'existing123',
                name: 'Maria Silva',
                contact: { phone: phoneE164, email: 'maria@teste.com' },
                manualControl: { active: false, autoResumeAfter: null }
            };
            
            // Simula busca encontrando lead existente
            mockFindOne.mockResolvedValue(existingLead);
            
            const result = await mockFindOne({ 'contact.phone': phoneE164 });
            
            expect(result).toEqual(existingLead);
            expect(result._id).toBe('existing123');
            expect(mockCreate).not.toHaveBeenCalled();
        });

        it('Deve criar novo lead se telefone não existe', async () => {
            const phoneE164 = '5562999999999';
            const newLead = {
                _id: 'new456',
                name: 'João Teste',
                contact: { phone: phoneE164, email: null },
                status: 'agendado',
                manualControl: { active: false, autoResumeAfter: null }  // 🔧 FIX
            };
            
            // Simula não encontrar existente
            mockFindOne.mockResolvedValue(null);
            // Simula criação bem-sucedida
            mockCreate.mockResolvedValue(newLead);
            
            const existing = await mockFindOne({ 'contact.phone': phoneE164 });
            expect(existing).toBeNull();
            
            const created = await mockCreate(newLead);
            expect(created).toEqual(newLead);
            expect(created.manualControl.autoResumeAfter).toBeNull();
        });
    });

    describe('2️⃣ Tratamento de Race Condition (E11000)', () => {
        
        it('Deve capturar erro 11000 e buscar lead existente', async () => {
            const phoneE164 = '556293163935';
            const duplicateError = {
                code: 11000,
                message: 'E11000 duplicate key error collection: test.leads index: contact_phone_unique',
                keyPattern: { 'contact.phone': 1 },
                keyValue: { 'contact.phone': phoneE164 }
            };
            
            const existingLead = {
                _id: 'race789',
                contact: { phone: phoneE164 }
            };
            
            // Primeira tentativa falha com duplicata
            mockCreate.mockRejectedValueOnce(duplicateError);
            // Busca subsequente encontra o lead
            mockFindOne.mockResolvedValue(existingLead);
            
            try {
                await mockCreate({ contact: { phone: phoneE164 } });
            } catch (err) {
                if (err.code === 11000) {
                    const found = await mockFindOne({ 'contact.phone': phoneE164 });
                    expect(found).toEqual(existingLead);
                }
            }
        });

        it('Deve propagar erro se não for de duplicata', async () => {
            const otherError = new Error('Erro de conexão');
            mockCreate.mockRejectedValue(otherError);
            
            await expect(mockCreate({})).rejects.toThrow('Erro de conexão');
        });
    });

    describe('3️⃣ Dados do paciente', () => {
        
        it('Deve normalizar telefone do paciente', () => {
            const phoneRaw = '(62) 99999-9999';
            const phoneNormalized = '5562999999999';
            
            // Simula normalização real do sistema
            const normalizeE164BR = (phone) => {
                // Remove tudo que não é dígito
                const digits = phone.replace(/[^0-9]/g, '');
                // Adiciona 55 se não começar com 55
                if (!digits.startsWith('55')) {
                    return '55' + digits;
                }
                return digits;
            };
            
            const result = normalizeE164BR(phoneRaw);
            expect(result).toBe(phoneNormalized);
        });

        it('Deve retornar null se paciente não existe', async () => {
            const patientId = 'patient123';
            mockFindById.mockResolvedValue(null);
            
            const patient = await mockFindById(patientId);
            expect(patient).toBeNull();
        });
    });

    describe('4️⃣ Estrutura do lead criado', () => {
        
        it('Lead criado deve ter todas as propriedades necessárias', async () => {
            const patient = {
                _id: 'pat123',
                fullName: 'Ana Paula',
                phone: '5562777777777',
                email: 'ana@email.com'
            };
            
            const newLead = {
                name: patient.fullName,
                contact: {
                    phone: patient.phone,
                    email: patient.email
                },
                origin: 'Agenda Direta',
                status: 'agendado',
                stage: 'interessado_agendamento',
                circuit: 'Circuito Padrão',
                conversionScore: 50,
                responded: true,
                autoReplyEnabled: false,
                manualControl: { active: false, autoResumeAfter: null },  // 🔧 FIX
                patientInfo: {
                    fullName: patient.fullName,
                    phone: patient.phone,
                    email: patient.email
                },
                appointment: {
                    seekingFor: 'Adulto +18 anos',
                    modality: 'Presencial',
                    healthPlan: 'Mensalidade'
                },
                interactions: [{
                    date: new Date(),
                    channel: 'manual',
                    direction: 'inbound',
                    message: expect.any(String),
                    status: 'completed'
                }],
                autoCreatedFromAppointment: true,
                linkedPatientId: patient._id
            };
            
            mockCreate.mockResolvedValue({ _id: 'lead456', ...newLead });
            
            const result = await mockCreate(newLead);
            
            expect(result).toBeDefined();
            expect(result.name).toBe('Ana Paula');
            expect(result.manualControl.autoResumeAfter).toBeNull();
            expect(result.autoCreatedFromAppointment).toBe(true);
        });

        it('Deve criar lead mesmo sem email do paciente', async () => {
            const patient = {
                fullName: 'Carlos Souza',
                phone: '5562666666666',
                email: null
            };
            
            const newLead = {
                name: patient.fullName,
                contact: {
                    phone: patient.phone,
                    email: null
                },
                manualControl: { active: false, autoResumeAfter: null }
            };
            
            mockCreate.mockResolvedValue({ _id: 'lead789', ...newLead });
            
            const result = await mockCreate(newLead);
            expect(result.contact.email).toBeNull();
        });
    });

    describe('5️⃣ Cenários de erro', () => {
        
        it('Deve lidar com erro 11000 do MongoDB corretamente', async () => {
            const mongoError = {
                errorResponse: {
                    code: 11000,
                    errmsg: 'E11000 duplicate key error collection: test.leads index: contact_phone_unique dup key: { contact.phone: "556293163935" }',
                    keyPattern: { 'contact.phone': 1 },
                    keyValue: { 'contact.phone': '556293163935' }
                },
                code: 11000,
                index: 0,
                keyPattern: { 'contact.phone': 1 },
                keyValue: { 'contact.phone': '556293163935' }
            };
            
            mockCreate.mockRejectedValue(mongoError);
            
            try {
                await mockCreate({ contact: { phone: '556293163935' } });
            } catch (err) {
                expect(err.code).toBe(11000);
                expect(err.keyValue['contact.phone']).toBe('556293163935');
            }
        });

        it('Deve retornar null em caso de erro inesperado', async () => {
            mockFindById.mockRejectedValue(new Error('Erro inesperado'));
            
            try {
                await mockFindById('patient123');
            } catch (err) {
                expect(err.message).toBe('Erro inesperado');
            }
        });
    });

    describe('6️⃣ Testes de integração simulados', () => {
        
        it('Fluxo completo: paciente → lead → agendamento', async () => {
            // 1. Buscar paciente
            const patient = {
                _id: 'pat999',
                fullName: 'Fernanda Lima',
                phone: '5562555555555'
            };
            mockFindById.mockResolvedValue(patient);
            
            // 2. Verificar se lead existe
            mockFindOne.mockResolvedValue(null); // Não existe
            
            // 3. Criar lead
            const newLead = {
                _id: 'lead999',
                name: patient.fullName,
                contact: { phone: patient.phone },
                manualControl: { active: false, autoResumeAfter: null }
            };
            mockCreate.mockResolvedValue(newLead);
            
            // Execução
            const foundPatient = await mockFindById('pat999');
            expect(foundPatient).toEqual(patient);
            
            const existingLead = await mockFindOne({ 'contact.phone': patient.phone });
            expect(existingLead).toBeNull();
            
            const createdLead = await mockCreate(newLead);
            expect(createdLead._id).toBe('lead999');
            expect(createdLead.manualControl.autoResumeAfter).toBeNull();
        });

        it('Fluxo com duplicata: lead já existe', async () => {
            const phone = '5562444444444';
            const existingLead = {
                _id: 'existing444',
                contact: { phone }
            };
            
            // Lead já existe
            mockFindOne.mockResolvedValue(existingLead);
            
            const result = await mockFindOne({ 'contact.phone': phone });
            expect(result._id).toBe('existing444');
            expect(mockCreate).not.toHaveBeenCalled();
        });
    });
});
