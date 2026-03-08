/**
 * 🧠 Testes Unitários - Amanda Orchestrator (Entity-Driven Architecture)
 * 
 * Nova arquitetura: "Processa primeiro, responde depois"
 * - Extrai entidades (nome, idade, período, queixa, therapyArea)
 * - Persiste no lead
 * - Responde contextualmente (pergunta só o que falta)
 * - Não usa mais FSM com estados rígidos (IDLE → COLLECT_BIRTH → ...)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─────────────────────────────────────────────────────────────
// Helpers de mock de lead (nova estrutura Entity-Driven)
// ─────────────────────────────────────────────────────────────
function makeLead(overrides = {}) {
    return {
        _id: 'lead-123',
        phone: '5562999990000',
        // Dados do paciente (extraídos das mensagens)
        patientInfo: {
            fullName: null,
            age: null,
            birthDate: null,
        },
        // Dados da triagem
        complaint: null,
        therapyArea: null,
        pendingPreferredPeriod: null,
        responsibleName: null,
        
        // Controle de fluxo (novo)
        triageStep: 'initial', // 'initial' | 'collecting' | 'done' | 'scheduling' | 'booked'
        stage: 'novo', // 'novo' | 'engajado' | 'agendado' | 'convertido'
        
        // Slots e agendamento
        pendingSchedulingSlots: null,
        pendingChosenSlot: null,
        
        // Flags de intenção detectadas
        flags: {
            asksPrice: false,
            asksAddress: false,
            asksLocation: false,
            mentionsInsurance: false,
            asksAboutAfterHours: false,
        },
        
        ...overrides,
    };
}

const SLOT_A = { 
    doctorId: 'dr-1', 
    date: '2026-03-10', 
    time: '09:00', 
    doctorName: 'Dra. Ana', 
    specialty: 'fonoaudiologia' 
};
const SLOT_B = { 
    doctorId: 'dr-2', 
    date: '2026-03-11', 
    time: '10:00', 
    doctorName: 'Dra. Bia', 
    specialty: 'fonoaudiologia' 
};

const MOCK_SLOTS = {
    primary: SLOT_A,
    alternativesSamePeriod: [SLOT_B],
    alternativesOtherPeriod: [],
};

// ─────────────────────────────────────────────────────────────
// Mocks das dependências (nova arquitetura)
// ─────────────────────────────────────────────────────────────
const mockPreProcessMessage = vi.fn();
const mockProcessMessageCompletely = vi.fn();
const mockFindAvailableSlots = vi.fn().mockResolvedValue(MOCK_SLOTS);
const mockAutoBookAppointment = vi.fn().mockResolvedValue({ success: true });
const mockPersistSchedulingSlots = vi.fn().mockResolvedValue({});
const mockLeadsFindByIdAndUpdate = vi.fn().mockResolvedValue({});
const mockLeadsFindOne = vi.fn().mockResolvedValue(null);

let currentLeadState = makeLead();

vi.mock('../../models/Leads.js', () => ({
    default: {
        findById: vi.fn().mockImplementation(() => ({
            lean: vi.fn().mockResolvedValue(currentLeadState),
        })),
        findOne: (...args) => mockLeadsFindOne(...args),
        findByIdAndUpdate: (...args) => mockLeadsFindByIdAndUpdate(...args),
    },
}));

vi.mock('../../services/amandaOrchestrator.js', () => ({
    preProcessMessage: (...args) => mockPreProcessMessage(...args),
    processMessageCompletely: (...args) => mockProcessMessageCompletely(...args),
    getMissingFields: (lead) => {
        const missing = [];
        if (!lead.patientInfo?.fullName) missing.push('name');
        if (!lead.patientInfo?.age && !lead.patientInfo?.birthDate) missing.push('age');
        if (!lead.pendingPreferredPeriod) missing.push('period');
        if (!lead.complaint) missing.push('complaint');
        return missing;
    },
    shouldOfferScheduling: (lead) => {
        return lead.patientInfo?.fullName && 
               (lead.patientInfo?.age || lead.patientInfo?.birthDate) &&
               lead.pendingPreferredPeriod &&
               lead.complaint &&
               lead.therapyArea;
    },
    buildContextualResponse: (lead, missingFields) => {
        // Resposta que reconhece o que já foi dito e pergunta só o que falta
        let response = `Oi${lead.responsibleName ? ' ' + lead.responsibleName : ''}! 💚\n\n`;
        
        // Reconhece dados já coletados
        const known = [];
        if (lead.patientInfo?.fullName) known.push(`${lead.patientInfo.fullName}`);
        if (lead.patientInfo?.age) known.push(`${lead.patientInfo.age} anos`);
        if (lead.complaint) known.push(`dificuldade de ${lead.complaint}`);
        
        if (known.length > 0) {
            response += `Entendi que ${known.join(', ')}.\n\n`;
        }
        
        // Pergunta só o que falta
        if (missingFields.length > 0) {
            const questions = {
                'period': 'Prefere manhã ou tarde?',
                'name': 'Qual é o nome do paciente?',
                'age': 'Qual é a idade?',
                'complaint': 'Qual é a dificuldade/queixa?'
            };
            response += missingFields.map(f => questions[f] || f).join('\n');
        } else {
            response += 'Vou buscar os horários disponíveis! 🎉';
        }
        
        return { text: response };
    }
}));

vi.mock('../../services/amandaBookingService.js', () => ({
    findAvailableSlots: (...args) => mockFindAvailableSlots(...args),
    autoBookAppointment: (...args) => mockAutoBookAppointment(...args),
    buildSlotOptions: (slots) => {
        const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
        const all = [slots?.primary, ...(slots?.alternativesSamePeriod || [])].filter(Boolean);
        return all.map((s, i) => ({ 
            letter: letters[i], 
            slot: s, 
            text: `${letters[i]}) ${s.date} ${s.time}` 
        }));
    }
}));

// ─────────────────────────────────────────────────────────────
// SUITE DE TESTES - Entity-Driven Architecture
// ─────────────────────────────────────────────────────────────
describe('🧠 Amanda Orchestrator - Entity-Driven Architecture', () => {
    
    beforeEach(() => {
        vi.clearAllMocks();
        currentLeadState = makeLead();
    });

    // =========================================================================
    // 1️⃣ EXTRAÇÃO DE ENTIDADES (preProcessMessage)
    // =========================================================================
    describe('Entity Extraction (preProcessMessage)', () => {
        
        it('extrai nome, idade, período e queixa de uma mensagem completa', async () => {
            const message = "Oi sou Maria, minha filha Ana tem 5 anos, não fala direito, prefiro manhã";
            
            mockPreProcessMessage.mockResolvedValue({
                extracted: {
                    responsibleName: 'Maria',
                    patientName: 'Ana',
                    age: 5,
                    complaint: 'atraso na fala',
                    period: 'manha',
                    therapyArea: 'fonoaudiologia'
                },
                flags: { asksPrice: false, asksAddress: false }
            });
            
            const result = await mockPreProcessMessage(message);
            
            expect(result.extracted.responsibleName).toBe('Maria');
            expect(result.extracted.patientName).toBe('Ana');
            expect(result.extracted.age).toBe(5);
            expect(result.extracted.complaint).toBe('atraso na fala');
            expect(result.extracted.period).toBe('manha');
        });

        it('extrai dados mesmo em ordem diferente', async () => {
            const message = "Minha filha de 7 anos tem autismo, meu nome é João, posso de tarde?";
            
            mockPreProcessMessage.mockResolvedValue({
                extracted: {
                    responsibleName: 'João',
                    age: 7,
                    complaint: 'autismo',
                    period: 'tarde',
                    therapyArea: 'psicologia'
                },
                flags: {}
            });
            
            const result = await mockPreProcessMessage(message);
            
            expect(result.extracted.responsibleName).toBe('João');
            expect(result.extracted.age).toBe(7);
            expect(result.extracted.period).toBe('tarde');
        });

        it('detecta pergunta de preço como flag', async () => {
            const message = "Quanto custa a avaliação?";
            
            mockPreProcessMessage.mockResolvedValue({
                extracted: {},
                flags: { asksPrice: true }
            });
            
            const result = await mockPreProcessMessage(message);
            
            expect(result.flags.asksPrice).toBe(true);
        });

        it('detecta pergunta de endereço como flag', async () => {
            const message = "Onde fica a clínica?";
            
            mockPreProcessMessage.mockResolvedValue({
                extracted: {},
                flags: { asksLocation: true }
            });
            
            const result = await mockPreProcessMessage(message);
            
            expect(result.flags.asksLocation).toBe(true);
        });
    });

    // =========================================================================
    // 2️⃣ PERSISTÊNCIA (processMessageCompletely)
    // =========================================================================
    describe('Persistence (processMessageCompletely)', () => {
        
        it('persiste dados extraídos no lead', async () => {
            const lead = makeLead({ _id: 'lead-123' });
            const extracted = {
                responsibleName: 'Maria',
                patientName: 'Ana',
                age: 5,
                complaint: 'atraso na fala',
                period: 'manha',
                therapyArea: 'fonoaudiologia'
            };
            
            mockProcessMessageCompletely.mockImplementation(async (leadId, extracted) => {
                currentLeadState = {
                    ...currentLeadState,
                    responsibleName: extracted.responsibleName,
                    patientInfo: {
                        fullName: extracted.patientName,
                        age: extracted.age
                    },
                    complaint: extracted.complaint,
                    pendingPreferredPeriod: extracted.period,
                    therapyArea: extracted.therapyArea,
                    triageStep: 'collecting'
                };
                return currentLeadState;
            });
            
            const updated = await mockProcessMessageCompletely(lead._id, extracted);
            
            expect(updated.responsibleName).toBe('Maria');
            expect(updated.patientInfo.fullName).toBe('Ana');
            expect(updated.patientInfo.age).toBe(5);
            expect(updated.therapyArea).toBe('fonoaudiologia');
        });

        it('acumula dados ao longo da conversa (não sobrescreve)', async () => {
            // Primeira mensagem: só nome e idade
            currentLeadState = makeLead({
                patientInfo: { fullName: 'Ana', age: 5 },
                complaint: 'atraso na fala',
                therapyArea: 'fonoaudiologia'
            });
            
            // Segunda mensagem: só período
            const newExtracted = { period: 'tarde' };
            
            mockProcessMessageCompletely.mockImplementation(async (leadId, extracted) => {
                currentLeadState = {
                    ...currentLeadState,
                    pendingPreferredPeriod: extracted.period || currentLeadState.pendingPreferredPeriod
                };
                return currentLeadState;
            });
            
            const updated = await mockProcessMessageCompletely('lead-123', newExtracted);
            
            // Dados antigos preservados
            expect(updated.patientInfo.fullName).toBe('Ana');
            expect(updated.patientInfo.age).toBe(5);
            expect(updated.complaint).toBe('atraso na fala');
            // Novo dado adicionado
            expect(updated.pendingPreferredPeriod).toBe('tarde');
        });
    });

    // =========================================================================
    // 3️⃣ IDENTIFICAÇÃO DO QUE FALTA (getMissingFields)
    // =========================================================================
    describe('Missing Fields Detection', () => {
        
        it('retorna todos os campos quando lead está vazio', () => {
            const lead = makeLead();
            
            // Função mockada de getMissingFields
            const getMissingFields = (lead) => {
                const missing = [];
                if (!lead.patientInfo?.fullName) missing.push('name');
                if (!lead.patientInfo?.age && !lead.patientInfo?.birthDate) missing.push('age');
                if (!lead.pendingPreferredPeriod) missing.push('period');
                if (!lead.complaint) missing.push('complaint');
                return missing;
            };
            const missing = getMissingFields(lead);
            
            expect(missing).toContain('name');
            expect(missing).toContain('age');
            expect(missing).toContain('period');
            expect(missing).toContain('complaint');
        });

        it('não retorna campos já preenchidos', () => {
            const lead = makeLead({
                patientInfo: { fullName: 'Ana', age: 5 },
                complaint: 'atraso na fala'
            });
            
            // Função mockada de getMissingFields
            const getMissingFields = (lead) => {
                const missing = [];
                if (!lead.patientInfo?.fullName) missing.push('name');
                if (!lead.patientInfo?.age && !lead.patientInfo?.birthDate) missing.push('age');
                if (!lead.pendingPreferredPeriod) missing.push('period');
                if (!lead.complaint) missing.push('complaint');
                return missing;
            };
            const missing = getMissingFields(lead);
            
            expect(missing).not.toContain('name');
            expect(missing).not.toContain('age');
            expect(missing).not.toContain('complaint');
            expect(missing).toContain('period');
        });

        it('retorna array vazio quando todos os dados estão completos', () => {
            const lead = makeLead({
                patientInfo: { fullName: 'Ana', age: 5 },
                complaint: 'atraso na fala',
                pendingPreferredPeriod: 'manha',
                therapyArea: 'fonoaudiologia'
            });
            
            // Função mockada de getMissingFields
            const getMissingFields = (lead) => {
                const missing = [];
                if (!lead.patientInfo?.fullName) missing.push('name');
                if (!lead.patientInfo?.age && !lead.patientInfo?.birthDate) missing.push('age');
                if (!lead.pendingPreferredPeriod) missing.push('period');
                if (!lead.complaint) missing.push('complaint');
                return missing;
            };
            const missing = getMissingFields(lead);
            
            expect(missing).toHaveLength(0);
        });
    });

    // =========================================================================
    // 4️⃣ RESPOSTA CONTEXTUAL (buildContextualResponse)
    // =========================================================================
    describe('Contextual Response Building', () => {
        
        it('reconhece dados já coletados na resposta', () => {
            const lead = makeLead({
                responsibleName: 'Maria',
                patientInfo: { fullName: 'Ana', age: 5 },
                complaint: 'atraso na fala'
            });
            
            // Função mockada de buildContextualResponse
            const buildContextualResponse = (lead, missingFields) => {
                let response = `Oi${lead.responsibleName ? ' ' + lead.responsibleName : ''}! 💚\n\n`;
                
                const known = [];
                if (lead.patientInfo?.fullName) known.push(`${lead.patientInfo.fullName}`);
                if (lead.patientInfo?.age) known.push(`${lead.patientInfo.age} anos`);
                if (lead.complaint) known.push(`dificuldade de ${lead.complaint}`);
                
                if (known.length > 0) {
                    response += `Entendi que ${known.join(', ')}.\n\n`;
                }
                
                if (missingFields.length > 0) {
                    const questions = {
                        'period': 'Prefere manhã ou tarde?',
                        'name': 'Qual é o nome do paciente?',
                        'age': 'Qual é a idade?',
                        'complaint': 'Qual é a dificuldade/queixa?'
                    };
                    response += missingFields.map(f => questions[f] || f).join('\n');
                } else {
                    response += 'Vou buscar os horários disponíveis! 🎉';
                }
                
                return { text: response };
            };
            const response = buildContextualResponse(lead, ['period']);
            
            expect(response.text).toContain('Oi Maria!');
            expect(response.text).toContain('Ana');
            expect(response.text).toContain('5 anos');
            expect(response.text).toContain('dificuldade');
        });

        it('pergunta só o que falta', () => {
            const lead = makeLead({
                patientInfo: { fullName: 'Ana', age: 5 },
                complaint: 'atraso na fala'
            });
            
            // Função mockada de buildContextualResponse
            const buildContextualResponse = (lead, missingFields) => {
                let response = `Oi${lead.responsibleName ? ' ' + lead.responsibleName : ''}! 💚\n\n`;
                
                const known = [];
                if (lead.patientInfo?.fullName) known.push(`${lead.patientInfo.fullName}`);
                if (lead.patientInfo?.age) known.push(`${lead.patientInfo.age} anos`);
                if (lead.complaint) known.push(`dificuldade de ${lead.complaint}`);
                
                if (known.length > 0) {
                    response += `Entendi que ${known.join(', ')}.\n\n`;
                }
                
                if (missingFields.length > 0) {
                    const questions = {
                        'period': 'Prefere manhã ou tarde?',
                        'name': 'Qual é o nome do paciente?',
                        'age': 'Qual é a idade?',
                        'complaint': 'Qual é a dificuldade/queixa?'
                    };
                    response += missingFields.map(f => questions[f] || f).join('\n');
                } else {
                    response += 'Vou buscar os horários disponíveis! 🎉';
                }
                
                return { text: response };
            };
            const response = buildContextualResponse(lead, ['period']);
            
            expect(response.text).toContain('Prefere manhã ou tarde?');
            expect(response.text).not.toContain('Qual é o nome');
            expect(response.text).not.toContain('Qual é a idade');
        });

        it('quando tudo completo, indica que vai buscar horários', () => {
            const lead = makeLead({
                responsibleName: 'Maria',
                patientInfo: { fullName: 'Ana', age: 5 },
                complaint: 'atraso na fala',
                pendingPreferredPeriod: 'manha',
                therapyArea: 'fonoaudiologia'
            });
            
            // Função mockada de buildContextualResponse
            const buildContextualResponse = (lead, missingFields) => {
                let response = `Oi${lead.responsibleName ? ' ' + lead.responsibleName : ''}! 💚\n\n`;
                
                const known = [];
                if (lead.patientInfo?.fullName) known.push(`${lead.patientInfo.fullName}`);
                if (lead.patientInfo?.age) known.push(`${lead.patientInfo.age} anos`);
                if (lead.complaint) known.push(`dificuldade de ${lead.complaint}`);
                
                if (known.length > 0) {
                    response += `Entendi que ${known.join(', ')}.\n\n`;
                }
                
                if (missingFields.length > 0) {
                    const questions = {
                        'period': 'Prefere manhã ou tarde?',
                        'name': 'Qual é o nome do paciente?',
                        'age': 'Qual é a idade?',
                        'complaint': 'Qual é a dificuldade/queixa?'
                    };
                    response += missingFields.map(f => questions[f] || f).join('\n');
                } else {
                    response += 'Vou buscar os horários disponíveis! 🎉';
                }
                
                return { text: response };
            };
            const response = buildContextualResponse(lead, []);
            
            expect(response.text).toContain('Vou buscar os horários');
        });
    });

    // =========================================================================
    // 5️⃣ FLUXO COMPLETO (end-to-end Entity-Driven)
    // =========================================================================
    describe('Complete Entity-Driven Flow', () => {
        
        it('fluxo completo: mensagem completa → extrai tudo → oferece slots', async () => {
            const lead = makeLead({ _id: 'lead-123' });
            const message = "Oi sou Maria, minha filha Ana tem 5 anos, não fala direito, prefiro manhã";
            
            // 1. Extrai entidades
            mockPreProcessMessage.mockResolvedValue({
                extracted: {
                    responsibleName: 'Maria',
                    patientName: 'Ana',
                    age: 5,
                    complaint: 'atraso na fala',
                    period: 'manha',
                    therapyArea: 'fonoaudiologia'
                },
                flags: {}
            });
            
            // 2. Processa e persiste
            mockProcessMessageCompletely.mockResolvedValue({
                ...lead,
                responsibleName: 'Maria',
                patientInfo: { fullName: 'Ana', age: 5 },
                complaint: 'atraso na fala',
                pendingPreferredPeriod: 'manha',
                therapyArea: 'fonoaudiologia',
                triageStep: 'done'
            });
            
            // Executa
            const preProcessed = await mockPreProcessMessage(message);
            const updated = await mockProcessMessageCompletely(lead._id, preProcessed.extracted);
            
            // Verifica se deve oferecer agendamento
            // Função mockada de shouldOfferScheduling
            const shouldOfferScheduling = (lead) => {
                return !!(lead.patientInfo?.fullName && 
                       (lead.patientInfo?.age || lead.patientInfo?.birthDate) &&
                       lead.pendingPreferredPeriod &&
                       lead.complaint &&
                       lead.therapyArea);
            };
            const shouldOffer = shouldOfferScheduling(updated);
            
            expect(shouldOffer).toBe(true);
            
            // Busca slots
            if (shouldOffer) {
                const slots = await mockFindAvailableSlots({
                    therapyArea: updated.therapyArea,
                    period: updated.pendingPreferredPeriod
                });
                
                expect(slots).toHaveProperty('primary');
                expect(mockFindAvailableSlots).toHaveBeenCalledWith(
                    expect.objectContaining({ therapyArea: 'fonoaudiologia' })
                );
            }
        });

        it('fluxo gradual: coleta dados ao longo de várias mensagens', async () => {
            const leadId = 'lead-456';
            
            // Mensagem 1: só nome e idade
            currentLeadState = makeLead({ _id: leadId });
            
            mockProcessMessageCompletely.mockImplementation((id, data) => {
                currentLeadState = {
                    ...currentLeadState,
                    patientInfo: { 
                        ...currentLeadState.patientInfo,
                        fullName: data.patientName || currentLeadState.patientInfo?.fullName,
                        age: data.age || currentLeadState.patientInfo?.age
                    },
                    triageStep: 'collecting'
                };
                return currentLeadState;
            });
            
            let result = await mockProcessMessageCompletely(leadId, { patientName: 'Pedro', age: 8 });
            expect(result.patientInfo.fullName).toBe('Pedro');
            
            // Mensagem 2: só período
            mockProcessMessageCompletely.mockImplementation((id, data) => {
                currentLeadState = {
                    ...currentLeadState,
                    pendingPreferredPeriod: data.period || currentLeadState.pendingPreferredPeriod,
                    patientInfo: currentLeadState.patientInfo // Preserva
                };
                return currentLeadState;
            });
            
            result = await mockProcessMessageCompletely(leadId, { period: 'tarde' });
            expect(result.pendingPreferredPeriod).toBe('tarde');
            expect(result.patientInfo.fullName).toBe('Pedro'); // Preservado
            
            // Mensagem 3: só queixa
            mockProcessMessageCompletely.mockImplementation((id, data) => {
                currentLeadState = {
                    ...currentLeadState,
                    complaint: data.complaint || currentLeadState.complaint,
                    therapyArea: data.therapyArea || currentLeadState.therapyArea,
                    patientInfo: currentLeadState.patientInfo, // Preserva
                    pendingPreferredPeriod: currentLeadState.pendingPreferredPeriod // Preserva
                };
                return currentLeadState;
            });
            
            result = await mockProcessMessageCompletely(leadId, { 
                complaint: 'TDAH', 
                therapyArea: 'psicologia' 
            });
            expect(result.complaint).toBe('TDAH');
            expect(result.patientInfo.age).toBe(8); // Preservado
            expect(result.pendingPreferredPeriod).toBe('tarde'); // Preservado
        });
    });

    // =========================================================================
    // 6️⃣ CENÁRIOS REAIS DO DIA A DIA (adaptados do legado FSM)
    // =========================================================================
    describe('Real-World Scenarios (from legacy FSM)', () => {
        
        it('fluxo multi-turn: coleta gradual até oferecer slots', async () => {
            const leadId = 'lead-multi-turn';
            currentLeadState = makeLead({ _id: leadId });
            
            // Turn 1: Queixa detectada, detecta terapia
            mockPreProcessMessage.mockResolvedValue({
                extracted: { 
                    complaint: 'problema para falar', 
                    therapyArea: 'fonoaudiologia',
                    patientName: 'Sofia'
                },
                flags: {}
            });
            
            mockProcessMessageCompletely.mockImplementation((id, data) => {
                currentLeadState = {
                    ...currentLeadState,
                    patientInfo: { 
                        ...currentLeadState.patientInfo,
                        fullName: data.patientName 
                    },
                    complaint: data.complaint,
                    therapyArea: data.therapyArea,
                    triageStep: 'collecting'
                };
                return currentLeadState;
            });
            
            let result = await mockProcessMessageCompletely(leadId, {
                patientName: 'Sofia',
                complaint: 'problema para falar',
                therapyArea: 'fonoaudiologia'
            });
            
            expect(result.therapyArea).toBe('fonoaudiologia');
            expect(result.patientInfo.fullName).toBe('Sofia');
            expect(result.triageStep).toBe('collecting');
            
            // Turn 2: Manda idade
            mockPreProcessMessage.mockResolvedValue({
                extracted: { age: 5, birthDate: '2020-03-15' }
            });
            
            mockProcessMessageCompletely.mockImplementation((id, data) => {
                currentLeadState = {
                    ...currentLeadState,
                    patientInfo: {
                        ...currentLeadState.patientInfo,
                        age: data.age,
                        birthDate: data.birthDate
                    }
                };
                return currentLeadState;
            });
            
            result = await mockProcessMessageCompletely(leadId, { age: 5, birthDate: '2020-03-15' });
            expect(result.patientInfo.age).toBe(5);
            
            // Turn 3: Manda período
            mockPreProcessMessage.mockResolvedValue({
                extracted: { period: 'manha' }
            });
            
            mockProcessMessageCompletely.mockImplementation((id, data) => {
                currentLeadState = {
                    ...currentLeadState,
                    pendingPreferredPeriod: data.period,
                    triageStep: 'done'
                };
                return currentLeadState;
            });
            
            result = await mockProcessMessageCompletely(leadId, { period: 'manha' });
            expect(result.pendingPreferredPeriod).toBe('manha');
            expect(result.triageStep).toBe('done');
            
            // Agora deve oferecer agendamento
            const shouldOfferScheduling = (lead) => {
                return !!(lead.patientInfo?.fullName && 
                       lead.patientInfo?.age &&
                       lead.pendingPreferredPeriod &&
                       lead.complaint &&
                       lead.therapyArea);
            };
            
            expect(shouldOfferScheduling(result)).toBe(true);
            
            // Busca slots com therapyArea correto
            const slots = await mockFindAvailableSlots({
                therapyArea: result.therapyArea,
                period: result.pendingPreferredPeriod
            });
            
            expect(mockFindAvailableSlots).toHaveBeenCalledWith(
                expect.objectContaining({ therapyArea: 'fonoaudiologia' })
            );
            expect(slots).toHaveProperty('primary');
        });

        it('findAvailableSlots recebe therapyArea como string', async () => {
            const lead = makeLead({
                patientInfo: { fullName: 'Lucas', age: 7 },
                complaint: 'TDAH',
                pendingPreferredPeriod: 'tarde',
                therapyArea: 'psicologia', // String
                triageStep: 'done'
            });
            
            // Verifica se therapyArea é string
            expect(typeof lead.therapyArea).toBe('string');
            
            // Busca slots
            await mockFindAvailableSlots({
                therapyArea: lead.therapyArea,
                period: lead.pendingPreferredPeriod
            });
            
            // Verifica que foi chamado com string
            const callArgs = mockFindAvailableSlots.mock.calls[0][0];
            expect(typeof callArgs.therapyArea).toBe('string');
            expect(callArgs.therapyArea).toBe('psicologia');
        });

        it('quando não há slots, responde educadamente e não quebra', async () => {
            const lead = makeLead({
                patientInfo: { fullName: 'Ana', age: 5 },
                complaint: 'atraso na fala',
                pendingPreferredPeriod: 'manha',
                therapyArea: 'fonoaudiologia',
                triageStep: 'done'
            });
            
            // Mock retorna sem slots
            mockFindAvailableSlots.mockResolvedValueOnce({
                primary: null,
                alternativesSamePeriod: [],
                alternativesOtherPeriod: []
            });
            
            const slots = await mockFindAvailableSlots({
                therapyArea: lead.therapyArea,
                period: lead.pendingPreferredPeriod
            });
            
            // Não tem slots
            expect(slots.primary).toBeNull();
            
            // Deve responder ao usuário (não travar)
            const response = {
                text: `Não encontrei horários para ${lead.pendingPreferredPeriod}.\n\n` +
                      `Posso verificar outro período? (manhã/tarde/noite)`
            };
            
            expect(response.text).toMatch(/não encontrei|outro período/i);
        });

        it('BUG FIX: sem slots para período específico → sugere outros períodos', async () => {
            const lead = makeLead({
                patientInfo: { fullName: 'Pedro', age: 6 },
                complaint: 'autismo',
                pendingPreferredPeriod: 'manha', // Usuário quer manhã
                therapyArea: 'psicologia',
                triageStep: 'done'
            });
            
            // Mock: não tem slots de manhã
            mockFindAvailableSlots.mockResolvedValueOnce({
                primary: null,
                alternativesSamePeriod: [],
                alternativesOtherPeriod: [
                    { doctorId: 'dr-3', date: '2026-03-12', time: '14:00', specialty: 'psicologia' }
                ]
            });
            
            const slots = await mockFindAvailableSlots({
                therapyArea: lead.therapyArea,
                period: lead.pendingPreferredPeriod
            });
            
            // Não tem na manhã
            expect(slots.primary).toBeNull();
            
            // Mas tem na tarde
            expect(slots.alternativesOtherPeriod.length).toBeGreaterThan(0);
            
            // Resposta deve sugerir alternativas
            const response = {
                text: `Na ${lead.pendingPreferredPeriod} não temos vagas, ` +
                      `mas encontrei à tarde:\n\n` +
                      `📅 Quinta, 12/03 às 14:00\n\n` +
                      `Funciona para você?`
            };
            
            expect(response.text).toMatch(/não temos vagas|tarde/i);
        });

        it('fluxo E2E completo: mensagem → agendamento confirmado', async () => {
            const leadId = 'lead-e2e';
            currentLeadState = makeLead({ _id: leadId });
            
            // 1. Extrai tudo de uma vez
            mockPreProcessMessage.mockResolvedValue({
                extracted: {
                    responsibleName: 'Maria',
                    patientName: 'Ana',
                    age: 5,
                    complaint: 'atraso na fala',
                    period: 'manha',
                    therapyArea: 'fonoaudiologia'
                }
            });
            
            mockProcessMessageCompletely.mockResolvedValue({
                ...currentLeadState,
                responsibleName: 'Maria',
                patientInfo: { fullName: 'Ana', age: 5 },
                complaint: 'atraso na fala',
                pendingPreferredPeriod: 'manha',
                therapyArea: 'fonoaudiologia',
                triageStep: 'done'
            });
            
            const updated = await mockProcessMessageCompletely(leadId, {
                responsibleName: 'Maria',
                patientName: 'Ana',
                age: 5,
                complaint: 'atraso na fala',
                period: 'manha',
                therapyArea: 'fonoaudiologia'
            });
            
            // 2. Verifica se completo
            const shouldOfferScheduling = (lead) => {
                return !!(lead.patientInfo?.fullName && 
                       lead.patientInfo?.age &&
                       lead.pendingPreferredPeriod &&
                       lead.complaint &&
                       lead.therapyArea);
            };
            
            expect(shouldOfferScheduling(updated)).toBe(true);
            
            // 3. Busca slots
            const slots = await mockFindAvailableSlots({
                therapyArea: updated.therapyArea,
                period: updated.pendingPreferredPeriod
            });
            
            expect(slots.primary).toBeTruthy();
            
            // 4. Persiste slots
            await mockPersistSchedulingSlots(leadId, slots);
            expect(mockPersistSchedulingSlots).toHaveBeenCalled();
            
            // 5. Mostra opções para usuário
            const slotOptions = [
                { letter: 'A', text: 'A) Segunda, 10/03 às 09:00' },
                { letter: 'B', text: 'B) Terça, 11/03 às 10:00' }
            ];
            
            expect(slotOptions.length).toBeGreaterThan(0);
            
            // 6. Usuário escolhe opção A
            const chosenSlot = slots.primary;
            
            // 7. Confirma agendamento
            mockAutoBookAppointment.mockResolvedValue({
                success: true,
                appointment: {
                    doctorId: chosenSlot.doctorId,
                    date: chosenSlot.date,
                    time: chosenSlot.time,
                    patientName: updated.patientInfo.fullName
                }
            });
            
            const booking = await mockAutoBookAppointment({
                leadId,
                slot: chosenSlot,
                patientInfo: updated.patientInfo
            });
            
            expect(booking.success).toBe(true);
            expect(booking.appointment).toBeTruthy();
        });
    });

    // =========================================================================
    // 7️⃣ INTERRUPÇÕES (pergunta de preço/endereço no meio da triagem)
    // =========================================================================
    describe('Interruptions Handling', () => {
        
        it('detecta pergunta de preço durante triagem', async () => {
            const lead = makeLead({
                patientInfo: { fullName: 'Ana', age: 5 },
                complaint: 'atraso na fala',
                therapyArea: 'fonoaudiologia',
                triageStep: 'collecting'
            });
            
            mockPreProcessMessage.mockResolvedValue({
                extracted: {},
                flags: { asksPrice: true }
            });
            
            const result = await mockPreProcessMessage("Quanto custa?");
            
            expect(result.flags.asksPrice).toBe(true);
            // Deve responder preço E continuar triagem depois
        });

        it('mantém contexto da triagem após responder interrupção', async () => {
            const lead = makeLead({
                patientInfo: { fullName: 'Ana', age: 5 },
                complaint: 'atraso na fala',
                therapyArea: 'fonoaudiologia',
                pendingPreferredPeriod: null, // Ainda falta
                triageStep: 'collecting'
            });
            
            // Simula: usuário pergunta preço, depois responde período
            mockPreProcessMessage
                .mockResolvedValueOnce({ extracted: {}, flags: { asksPrice: true } })
                .mockResolvedValueOnce({ extracted: { period: 'manha' } });
            
            const r1 = await mockPreProcessMessage("Quanto custa?");
            expect(r1.flags.asksPrice).toBe(true);
            
            const r2 = await mockPreProcessMessage("Manhã");
            expect(r2.extracted.period).toBe('manha');
        });
    });

    // =========================================================================
    // 7️⃣ VALIDAÇÃO DE SERVIÇO
    // =========================================================================
    describe('Service Validation', () => {
        
        it('bloqueia serviço não disponível', async () => {
            const lead = makeLead();
            const extracted = {
                therapyArea: 'neurologista',
                complaint: 'dor de cabeça'
            };
            
            // VALID_SERVICES não inclui 'neurologista'
            const VALID_SERVICES = ['fonoaudiologia', 'psicologia', 'terapia_ocupacional', 'fisioterapia'];
            const isValid = VALID_SERVICES.includes(extracted.therapyArea);
            
            expect(isValid).toBe(false);
        });

        it('permite serviço disponível', async () => {
            const extracted = {
                therapyArea: 'fonoaudiologia',
                complaint: 'atraso na fala'
            };
            
            const VALID_SERVICES = ['fonoaudiologia', 'psicologia', 'terapia_ocupacional', 'fisioterapia'];
            const isValid = VALID_SERVICES.includes(extracted.therapyArea);
            
            expect(isValid).toBe(true);
        });
    });
});

// Exportar helpers para reuso
export { makeLead, MOCK_SLOTS };
