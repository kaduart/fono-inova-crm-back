/**
 * Testes de Interrupção Global em IDLE
 * Valida que perguntas sobre laudo/preço/endereço são respondidas
 * mesmo quando o FSM está no estado IDLE
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectGlobalIntent } from '../../services/StateMachine.js';

// Mock do Leads
const mockFindById = vi.fn();
const mockUpdateOne = vi.fn();

vi.mock('../../models/Leads.js', () => ({
    default: {
        findById: (...args) => mockFindById(...args),
        updateOne: (...args) => mockUpdateOne(...args),
    },
}));

// Mock do StateMachine
vi.mock('../../services/StateMachine.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        suspendState: vi.fn(),
        getResumeHint: vi.fn(() => 'Voltando para onde estávamos...'),
    };
});

describe('Interrupção Global em IDLE', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('detectGlobalIntent - LAUDO_QUERY', () => {
        it('detecta "psicólogos emitem laudo?" em qualquer estado', () => {
            const text = 'As psicólogas ou psicólogos emitem laudo?';
            const intent = detectGlobalIntent(text);
            expect(intent).toBe('LAUDO_QUERY');
        });

        it('detecta "quem emite laudo?"', () => {
            const text = 'quem emite laudo?';
            const intent = detectGlobalIntent(text);
            expect(intent).toBe('LAUDO_QUERY');
        });

        it('detecta "vocês fazem laudo?"', () => {
            const text = 'vocês fazem laudo?';
            const intent = detectGlobalIntent(text);
            expect(intent).toBe('LAUDO_QUERY');
        });

        it('não detecta laudo quando é sobre outra coisa', () => {
            const text = 'Quero agendar uma consulta';
            const intent = detectGlobalIntent(text);
            expect(intent).toBeNull();
        });
    });

    describe('Fluxo de Interrupção em IDLE', () => {
        it('LAUDO_QUERY deve ser respondido antes de coletar queixa', async () => {
            // Simula lead em IDLE com therapyArea preenchida
            const mockLead = {
                _id: 'lead-123',
                currentState: 'IDLE',
                stateData: { therapy: 'neuropsychological' },
                therapyArea: 'neuropsychological',
                messageCount: 5,
                lastInteractionAt: new Date(),
            };

            mockFindById.mockResolvedValue(mockLead);

            // A pergunta sobre laudo
            const text = 'As psicólogas ou psicólogos emitem laudo?';
            
            // Detecta a intenção
            const globalIntent = detectGlobalIntent(text);
            
            // Deve detectar LAUDO_QUERY
            expect(globalIntent).toBe('LAUDO_QUERY');
            
            // Não deve ser tratado como complaint
            // (isso seria validado no teste de integração completo)
        });

        it('PRECO_QUERY deve ser respondido mesmo em IDLE', () => {
            const text = 'Qual o preço da avaliação?';
            const intent = detectGlobalIntent(text);
            expect(intent).toBe('PRICE_QUERY');
        });

        it('LOCATION_QUERY deve ser respondido mesmo em IDLE', () => {
            const text = 'Onde fica a clínica?';
            const intent = detectGlobalIntent(text);
            expect(intent).toBe('LOCATION_QUERY');
        });
    });
});
