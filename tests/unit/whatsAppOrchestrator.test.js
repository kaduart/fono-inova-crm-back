/**
 * Testes unitários — WhatsAppOrchestrator.js
 *
 * Cobre todos os estados da FSM e valida:
 * - Detecção de terapia no IDLE (retorna objeto, stateData recebe string ID)
 * - Fluxo completo até agendamento
 * - Interrupções globais (preço, endereço, plano)
 * - Retomada pós-interrupção
 * - autoBookAppointment chamado no CONFIRM_BOOKING
 * - therapyArea correto para findAvailableSlots
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─────────────────────────────────────────────────────────────
// Helpers de mock de lead
// ─────────────────────────────────────────────────────────────
function makeLead(overrides = {}) {
    return {
        _id: 'lead-123',
        currentState: null,
        stateData: {},
        stateStack: [],
        retryCount: 0,
        therapyArea: null,
        phone: '5562999990000',
        patientInfo: {},
        pendingSchedulingSlots: null,
        pendingChosenSlot: null,
        ...overrides,
    };
}

const SLOT_A = { doctorId: 'dr-1', date: '2026-03-10', time: '09:00', doctorName: 'Dra. Ana', specialty: 'fonoaudiologia' };
const SLOT_B = { doctorId: 'dr-2', date: '2026-03-11', time: '10:00', doctorName: 'Dra. Bia', specialty: 'fonoaudiologia' };

const MOCK_SLOTS = {
    primary: SLOT_A,
    alternativesSamePeriod: [SLOT_B],
    alternativesOtherPeriod: [],
};

// ─────────────────────────────────────────────────────────────
// Mocks das dependências
// ─────────────────────────────────────────────────────────────
const mockJumpToState   = vi.fn().mockResolvedValue({});
const mockSuspendState  = vi.fn().mockResolvedValue({});
const mockResumeState   = vi.fn().mockResolvedValue(null);
const mockIncrementRetry = vi.fn().mockResolvedValue({ count: 1, handoff: false });
const mockFindAvailableSlots   = vi.fn().mockResolvedValue(MOCK_SLOTS);
const mockAutoBookAppointment  = vi.fn().mockResolvedValue({ success: true });
const mockPersistSchedulingSlots = vi.fn().mockResolvedValue({});
const mockBookingHandlerExecute  = vi.fn().mockResolvedValue({
    text: 'Encontrei essas opções:\n\nA) Seg 10/03 às 9h com Dra. Ana\nB) Ter 11/03 às 10h com Dra. Bia',
});
const mockLeadsUpdateOne    = vi.fn().mockResolvedValue({});
const mockLeadsFindByIdAndUpdate = vi.fn().mockResolvedValue({});

// Leads.findById encadeia .lean() — precisa retornar o lead fresco
let currentLeadState = makeLead();
const mockLeadsFindById = vi.fn().mockImplementation(() => ({
    lean: vi.fn().mockResolvedValue(currentLeadState),
}));

vi.mock('../../models/Leads.js', () => ({
    default: {
        findById: (...args) => mockLeadsFindById(...args),
        updateOne: (...args) => mockLeadsUpdateOne(...args),
        findByIdAndUpdate: (...args) => mockLeadsFindByIdAndUpdate(...args),
    },
}));

vi.mock('../../services/StateMachine.js', () => ({
    STATES: {
        IDLE: 'IDLE', GREETING: 'GREETING', COLLECT_THERAPY: 'COLLECT_THERAPY',
        COLLECT_NAME: 'COLLECT_NAME', COLLECT_BIRTH: 'COLLECT_BIRTH',
        COLLECT_COMPLAINT: 'COLLECT_COMPLAINT', COLLECT_PERIOD: 'COLLECT_PERIOD',
        SHOW_SLOTS: 'SHOW_SLOTS', CONFIRM_BOOKING: 'CONFIRM_BOOKING',
        COLLECT_PATIENT_DATA: 'COLLECT_PATIENT_DATA', BOOKED: 'BOOKED',
        INTERRUPTED: 'INTERRUPTED', HANDOFF: 'HANDOFF',
    },
    jumpToState:    (...args) => mockJumpToState(...args),
    suspendState:   (...args) => mockSuspendState(...args),
    resumeState:    (...args) => mockResumeState(...args),
    incrementRetry: (...args) => mockIncrementRetry(...args),
    advanceState:   vi.fn().mockResolvedValue({}),
    detectGlobalIntent: vi.fn((text) => {
        if (/pre[çc]o|valor|custa/i.test(text)) return 'PRICE_QUERY';
        if (/endere[çc]o|onde\s*fica/i.test(text)) return 'LOCATION_QUERY';
        if (/plano|conv[eê]nio/i.test(text)) return 'INSURANCE_QUERY';
        return null;
    }),
    getResumeHint: vi.fn((state) => `...continuando de onde paramos! 💚`),
    isAutoResume:  vi.fn().mockReturnValue(false),
}));

vi.mock('../../services/amandaBookingService.js', () => ({
    findAvailableSlots:  (...args) => mockFindAvailableSlots(...args),
    autoBookAppointment: (...args) => mockAutoBookAppointment(...args),
    buildSlotOptions: (slots) => {
        const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
        const all = [slots?.primary, ...(slots?.alternativesSamePeriod || []), ...(slots?.alternativesOtherPeriod || [])].filter(Boolean);
        return all.map((s, i) => ({ letter: letters[i], slot: s, text: `${letters[i]}) ${s.date} ${s.time}` }));
    },
    formatSlot: (s) => `${s.date} às ${s.time} com ${s.doctorName}`,
}));

vi.mock('../../infrastructure/persistence/LeadRepository.js', () => ({
    leadRepository: {
        persistSchedulingSlots: (...args) => mockPersistSchedulingSlots(...args),
    },
}));

vi.mock('../../handlers/BookingHandler.js', () => ({
    default: { execute: (...args) => mockBookingHandlerExecute(...args) },
}));

vi.mock('../../perception/PerceptionService.js', () => ({
    perceptionService: {
        analyze: vi.fn().mockResolvedValue({
            therapies: { primary: null, alternatives: [], count: 0 },
            flags: {}, entities: {}, intent: { type: 'information' },
        }),
    },
}));

vi.mock('../../services/amandaLearningService.js', () => ({
    getLatestInsights: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../adapters/BookingContextAdapter.js', () => ({
    buildDecisionContext: vi.fn((p) => ({
        message: { text: p.message || '' },
        lead: p.lead,
        memory: p.context || {},
        missing: { needsSlotSelection: true, needsSlot: false, needsName: false },
        booking: { slots: p.slots, chosenSlot: null },
        analysis: {},
    })),
}));

vi.mock('../../config/pricing.js', () => ({
    PRICES: { avaliacaoInicial: 'R$ 200', sessaoAvulsa: 'R$ 150', neuropsicologica: 'R$ 2.000' },
    formatPrice: (v) => `R$ ${v}`,
    getTherapyPricing: vi.fn().mockReturnValue({ avaliacao: 200 }),
}));

vi.mock('../../services/utils/Logger.js', () => ({
    default: class { info() {} warn() {} error() {} debug() {} },
}));

// ─────────────────────────────────────────────────────────────
// Import real do orchestrator (após os mocks)
// ─────────────────────────────────────────────────────────────
const { default: WhatsAppOrchestrator } = await import('../../orchestrators/WhatsAppOrchestrator.js');

// ─────────────────────────────────────────────────────────────
// Helpers de teste
// ─────────────────────────────────────────────────────────────
function makeMessage(content) {
    return { content };
}

async function processMsg(lead, content) {
    const orchestrator = new WhatsAppOrchestrator();
    return orchestrator.process({ lead, message: makeMessage(content) });
}

// ─────────────────────────────────────────────────────────────
// TESTES
// ─────────────────────────────────────────────────────────────
describe('WhatsAppOrchestrator — FSM real', () => {

    beforeEach(() => {
        vi.clearAllMocks();
        currentLeadState = makeLead();
        mockFindAvailableSlots.mockResolvedValue(MOCK_SLOTS);
        mockAutoBookAppointment.mockResolvedValue({ success: true });
        mockIncrementRetry.mockResolvedValue({ count: 1, handoff: false });
        mockJumpToState.mockResolvedValue({});
    });

    // ─────────────────────────────
    // Circuit Breakers
    // ─────────────────────────────
    describe('Circuit Breakers', () => {
        it('retorna NO_REPLY para lead sem _id', async () => {
            const result = await processMsg({ _id: null }, 'oi');
            expect(result.command).toBe('NO_REPLY');
        });

        it('retorna NO_REPLY para mensagem de encerramento puro', async () => {
            currentLeadState = makeLead({ _id: 'lead-123' });
            const result = await processMsg({ _id: 'lead-123' }, 'obrigada!');
            expect(result.command).toBe('NO_REPLY');
        });

        it('cancela e limpa estado quando lead envia "cancelar"', async () => {
            currentLeadState = makeLead({ _id: 'lead-123' });
            const result = await processMsg({ _id: 'lead-123' }, 'cancelar');
            expect(result.command).toBe('SEND_MESSAGE');
            expect(result.payload.text).toContain('Cancelado');
        });
    });

    // ─────────────────────────────
    // IDLE — primeiro contato
    // ─────────────────────────────
    describe('ESTADO IDLE', () => {
        it('detecta terapia no primeiro msg e vai para COLLECT_COMPLAINT', async () => {
            currentLeadState = makeLead({ currentState: null });
            const result = await processMsg({ _id: 'lead-123' }, 'quero fono');

            expect(result.command).toBe('SEND_MESSAGE');
            // Deve ter ido para COLLECT_COMPLAINT com therapy como string ID
            const jumpCall = mockJumpToState.mock.calls.find(c => c[1] === 'COLLECT_COMPLAINT');
            expect(jumpCall).toBeTruthy();
            expect(typeof jumpCall[2].therapy).toBe('string'); // 'speech', não objeto
            expect(result.payload.text).toContain('situação');
        });

        it('stateData.therapy armazena string ID, não objeto', async () => {
            currentLeadState = makeLead({ currentState: null });
            await processMsg({ _id: 'lead-123' }, 'quero fonoaudiologia');

            const jumpCall = mockJumpToState.mock.calls.find(c => c[1] === 'COLLECT_COMPLAINT');
            expect(jumpCall).toBeTruthy();
            const therapyStored = jumpCall[2].therapy;
            expect(typeof therapyStored).toBe('string');
            expect(therapyStored).not.toContain('[object');
            expect(therapyStored).toBe('speech');
        });

        it('quando não detecta terapia, vai para COLLECT_THERAPY', async () => {
            currentLeadState = makeLead({ currentState: null });
            const result = await processMsg({ _id: 'lead-123' }, 'oi quero saber mais');

            const jumpCall = mockJumpToState.mock.calls.find(c => c[1] === 'COLLECT_THERAPY');
            expect(jumpCall).toBeTruthy();
            expect(result.payload.text).toContain('especialidade');
        });
    });

    // ─────────────────────────────
    // COLLECT_THERAPY
    // ─────────────────────────────
    describe('ESTADO COLLECT_THERAPY', () => {
        it('detecta psicologia e armazena ID como string', async () => {
            currentLeadState = makeLead({ currentState: 'COLLECT_THERAPY' });
            const result = await processMsg({ _id: 'lead-123' }, 'preciso de psicólogo');

            expect(result.command).toBe('SEND_MESSAGE');
            const jumpCall = mockJumpToState.mock.calls.find(c => c[1] === 'COLLECT_COMPLAINT');
            expect(jumpCall).toBeTruthy();
            expect(typeof jumpCall[2].therapy).toBe('string');
            expect(jumpCall[2].therapy).toBe('psychology');
        });

        it('não entendeu terapia → incrementa retry', async () => {
            currentLeadState = makeLead({ currentState: 'COLLECT_THERAPY' });
            await processMsg({ _id: 'lead-123' }, 'bom dia como vai');
            expect(mockIncrementRetry).toHaveBeenCalledWith('lead-123');
        });

        it('após 3 retries → handoff', async () => {
            mockIncrementRetry.mockResolvedValueOnce({ count: 3, handoff: true });
            currentLeadState = makeLead({ currentState: 'COLLECT_THERAPY' });
            const result = await processMsg({ _id: 'lead-123' }, 'não sei');
            expect(result.payload.text).toContain('atendente');
        });
    });

    // ─────────────────────────────
    // COLLECT_COMPLAINT
    // ─────────────────────────────
    describe('ESTADO COLLECT_COMPLAINT', () => {
        it('aceita queixa e extrai idade → pula para COLLECT_PERIOD', async () => {
            currentLeadState = makeLead({
                currentState: 'COLLECT_COMPLAINT',
                stateData: { therapy: 'speech' },
                therapyArea: 'fonoaudiologia',
            });
            const result = await processMsg({ _id: 'lead-123' }, 'meu filho não fala, tem 5 anos');

            expect(result.command).toBe('SEND_MESSAGE');
            const jumpCall = mockJumpToState.mock.calls.find(c => c[1] === 'COLLECT_PERIOD');
            expect(jumpCall).toBeTruthy();
            expect(jumpCall[2].age).toBeTruthy();
            expect(result.payload.text).toContain('manhã ou tarde');
        });

        it('queixa sem idade → vai para COLLECT_BIRTH', async () => {
            currentLeadState = makeLead({ currentState: 'COLLECT_COMPLAINT', stateData: { therapy: 'speech' } });
            await processMsg({ _id: 'lead-123' }, 'minha filha tem problema de fala');

            const jumpCall = mockJumpToState.mock.calls.find(c => c[1] === 'COLLECT_BIRTH');
            expect(jumpCall).toBeTruthy();
        });

        it('mensagem curta (<= 5 chars) → retry', async () => {
            currentLeadState = makeLead({ currentState: 'COLLECT_COMPLAINT', stateData: { therapy: 'speech' } });
            await processMsg({ _id: 'lead-123' }, 'oi');
            expect(mockIncrementRetry).toHaveBeenCalled();
        });
    });

    // ─────────────────────────────
    // COLLECT_BIRTH
    // ─────────────────────────────
    describe('ESTADO COLLECT_BIRTH', () => {
        it('extrai idade e vai para COLLECT_PERIOD', async () => {
            currentLeadState = makeLead({ currentState: 'COLLECT_BIRTH', stateData: { therapy: 'speech', complaint: 'atraso fala' } });
            const result = await processMsg({ _id: 'lead-123' }, '7 anos');

            const jumpCall = mockJumpToState.mock.calls.find(c => c[1] === 'COLLECT_PERIOD');
            expect(jumpCall).toBeTruthy();
            expect(result.payload.text).toContain('manhã');
        });

        it('extrai data dd/mm/yyyy e vai para COLLECT_PERIOD', async () => {
            // Regressão: bug do legado — "28/11/2015" ficava em loop, nunca avançava
            currentLeadState = makeLead({ currentState: 'COLLECT_BIRTH', stateData: { therapy: 'speech', complaint: 'atraso fala' } });
            const result = await processMsg({ _id: 'lead-123' }, '28/11/2015');

            const jumpCall = mockJumpToState.mock.calls.find(c => c[1] === 'COLLECT_PERIOD');
            expect(jumpCall).toBeTruthy();
            expect(jumpCall[2].birthDate).toBe('2015-11-28');
            expect(result.payload.text).toMatch(/manhã|tarde/i);
        });

        it('extrai data com traço dd-mm-yyyy e vai para COLLECT_PERIOD', async () => {
            currentLeadState = makeLead({ currentState: 'COLLECT_BIRTH', stateData: { therapy: 'speech' } });
            await processMsg({ _id: 'lead-123' }, '28-11-2015');

            const jumpCall = mockJumpToState.mock.calls.find(c => c[1] === 'COLLECT_PERIOD');
            expect(jumpCall).toBeTruthy();
            expect(jumpCall[2].birthDate).toBe('2015-11-28');
        });

        it('data por extenso ("28 de novembro de 2015") → reconhece e vai para COLLECT_PERIOD', async () => {
            currentLeadState = makeLead({ currentState: 'COLLECT_BIRTH', stateData: { therapy: 'speech' } });
            await processMsg({ _id: 'lead-123' }, '28 de novembro de 2015');

            const jumpCall = mockJumpToState.mock.calls.find(c => c[1] === 'COLLECT_PERIOD');
            expect(jumpCall).toBeTruthy();
            expect(jumpCall[2].birthDate).toBe('2015-11-28');
        });

        it('resposta sem idade → retry', async () => {
            currentLeadState = makeLead({ currentState: 'COLLECT_BIRTH', stateData: { therapy: 'speech' } });
            await processMsg({ _id: 'lead-123' }, 'não sei');
            expect(mockIncrementRetry).toHaveBeenCalled();
        });
    });

    // ─────────────────────────────────────────────────────
    // Regressão — Caso real WhatsApp 3777
    // Bug crítico identificado em 06/03/2026:
    // Lead enviou "28/11/2015" 3 vezes + "28 de novembro de 2015"
    // e o sistema legado nunca avançou o estado.
    // ─────────────────────────────────────────────────────
    describe('Regressão — Caso real WhatsApp 3777', () => {
        it('COLLECT_COMPLAINT: "queria marcar consulta com fonoaudiólogo" → detecta queixa fono → vai para COLLECT_BIRTH', async () => {
            currentLeadState = makeLead({
                currentState: 'COLLECT_COMPLAINT',
                stateData: { therapy: 'speech' },
                therapyArea: 'fonoaudiologia',
            });
            await processMsg({ _id: 'lead-123' }, 'Eu queria marcar uma consulta com um fonoaudiólogo');

            // Queixa detectada (fonoaudiologia), sem idade → vai para COLLECT_BIRTH
            const jumpCall = mockJumpToState.mock.calls.find(c => c[1] === 'COLLECT_BIRTH');
            expect(jumpCall).toBeTruthy();
        });

        it('COLLECT_BIRTH: data "28/11/2015" avança na PRIMEIRA tentativa, sem loop', async () => {
            currentLeadState = makeLead({ currentState: 'COLLECT_BIRTH', stateData: { therapy: 'speech' } });

            const result = await processMsg({ _id: 'lead-123' }, '28/11/2015');

            // NÃO deve ter chamado retry (bug do legado: ficava em loop)
            expect(mockIncrementRetry).not.toHaveBeenCalled();
            // Deve ter avançado para COLLECT_PERIOD
            const jumpCall = mockJumpToState.mock.calls.find(c => c[1] === 'COLLECT_PERIOD');
            expect(jumpCall).toBeTruthy();
            // Deve ter salvo a data corretamente
            expect(jumpCall[2].birthDate).toBe('2015-11-28');
            expect(result.command).toBe('SEND_MESSAGE');
        });

        it('fluxo multi-turn: fono → queixa sem idade → data de nascimento → período', async () => {
            const leadId = 'lead-3777';
            let result;
            vi.clearAllMocks();

            // Turn 1: queixa detectada, sem idade → COLLECT_BIRTH
            currentLeadState = makeLead({ _id: leadId, currentState: 'COLLECT_COMPLAINT', stateData: { therapy: 'speech' }, therapyArea: 'fonoaudiologia' });
            result = await processMsg({ _id: leadId }, 'minha filha tem problema para falar');
            expect(mockJumpToState).toHaveBeenCalledWith(leadId, 'COLLECT_BIRTH', expect.any(Object));
            vi.clearAllMocks();

            // Turn 2: usuário manda idade "10 anos" → COLLECT_PERIOD
            currentLeadState = makeLead({ _id: leadId, currentState: 'COLLECT_BIRTH', stateData: { therapy: 'speech' }, therapyArea: 'fonoaudiologia' });
            result = await processMsg({ _id: leadId }, 'Para criança de 10 anos');
            expect(mockJumpToState).toHaveBeenCalledWith(leadId, 'COLLECT_PERIOD', expect.objectContaining({ age: expect.objectContaining({ age: 10 }) }));
            vi.clearAllMocks();

            // Turn 3: período → busca slots
            currentLeadState = makeLead({ _id: leadId, currentState: 'COLLECT_PERIOD', stateData: { therapy: 'speech', age: { age: 10 } }, therapyArea: 'fonoaudiologia' });
            result = await processMsg({ _id: leadId }, 'manhã');
            expect(mockFindAvailableSlots).toHaveBeenCalledWith(expect.objectContaining({ therapyArea: 'fonoaudiologia' }));
            expect(mockPersistSchedulingSlots).toHaveBeenCalled();
        });
    });

    // ─────────────────────────────
    // COLLECT_PERIOD
    // ─────────────────────────────
    describe('ESTADO COLLECT_PERIOD', () => {
        it('extrai período e chama findAvailableSlots com lead.therapyArea', async () => {
            currentLeadState = makeLead({
                currentState: 'COLLECT_PERIOD',
                stateData: { therapy: 'speech', complaint: 'atraso fala', age: { age: 5 } },
                therapyArea: 'fonoaudiologia', // valor correto para query MongoDB
            });
            await processMsg({ _id: 'lead-123' }, 'prefiro manhã');

            expect(mockFindAvailableSlots).toHaveBeenCalledWith(
                expect.objectContaining({ therapyArea: 'fonoaudiologia' })
            );
        });

        it('findAvailableSlots NÃO recebe objeto como therapyArea', async () => {
            currentLeadState = makeLead({
                currentState: 'COLLECT_PERIOD',
                stateData: { therapy: { id: 'speech', name: 'Fonoaudiologia' } }, // objeto legado
                therapyArea: 'fonoaudiologia', // lead.therapyArea tem prioridade
            });
            await processMsg({ _id: 'lead-123' }, 'tarde');

            const callArgs = mockFindAvailableSlots.mock.calls[0]?.[0];
            expect(typeof callArgs?.therapyArea).toBe('string');
            expect(callArgs?.therapyArea).toBe('fonoaudiologia');
        });

        it('persiste slots após encontrar vagas', async () => {
            currentLeadState = makeLead({
                currentState: 'COLLECT_PERIOD',
                stateData: { therapy: 'speech' },
                therapyArea: 'fonoaudiologia',
            });
            await processMsg({ _id: 'lead-123' }, 'manhã');
            expect(mockPersistSchedulingSlots).toHaveBeenCalledWith('lead-123', MOCK_SLOTS);
        });

        it('sem slots disponíveis → mensagem de alternativa', async () => {
            mockFindAvailableSlots.mockResolvedValueOnce({ primary: null, alternativesSamePeriod: [], alternativesOtherPeriod: [] });
            currentLeadState = makeLead({
                currentState: 'COLLECT_PERIOD',
                stateData: { therapy: 'speech' },
                therapyArea: 'fonoaudiologia',
            });
            const result = await processMsg({ _id: 'lead-123' }, 'manhã');
            expect(result.payload.text).toMatch(/não encontrei|outro período/i);
        });
    });

    // ─────────────────────────────
    // SHOW_SLOTS
    // ─────────────────────────────
    describe('ESTADO SHOW_SLOTS', () => {
        it('escolha A → vai para COLLECT_PATIENT_DATA', async () => {
            currentLeadState = makeLead({ currentState: 'SHOW_SLOTS', stateData: { therapy: 'speech' } });
            const result = await processMsg({ _id: 'lead-123' }, 'A');

            const jumpCall = mockJumpToState.mock.calls.find(c => c[1] === 'COLLECT_PATIENT_DATA');
            expect(jumpCall).toBeTruthy();
            expect(jumpCall[2].chosenSlot).toBe('A');
            expect(result.payload.text).toContain('nome completo');
        });

        it('escolha B também aceita', async () => {
            currentLeadState = makeLead({ currentState: 'SHOW_SLOTS', stateData: {} });
            await processMsg({ _id: 'lead-123' }, 'B');
            const jumpCall = mockJumpToState.mock.calls.find(c => c[1] === 'COLLECT_PATIENT_DATA');
            expect(jumpCall?.[2].chosenSlot).toBe('B');
        });

        it('letra inválida → retry', async () => {
            currentLeadState = makeLead({ currentState: 'SHOW_SLOTS', stateData: {} });
            await processMsg({ _id: 'lead-123' }, 'quero outro');
            expect(mockIncrementRetry).toHaveBeenCalled();
        });
    });

    // ─────────────────────────────
    // COLLECT_PATIENT_DATA
    // ─────────────────────────────
    describe('ESTADO COLLECT_PATIENT_DATA', () => {
        it('nome válido → vai para CONFIRM_BOOKING', async () => {
            currentLeadState = makeLead({ currentState: 'COLLECT_PATIENT_DATA', stateData: { chosenSlot: 'A' } });
            const result = await processMsg({ _id: 'lead-123' }, 'Maria Silva');

            const jumpCall = mockJumpToState.mock.calls.find(c => c[1] === 'CONFIRM_BOOKING');
            expect(jumpCall).toBeTruthy();
            expect(jumpCall[2].patientName).toBe('Maria Silva');
            expect(result.payload.text).toContain('confirmar');
        });

        it('texto sem nome válido → retry', async () => {
            currentLeadState = makeLead({ currentState: 'COLLECT_PATIENT_DATA', stateData: { chosenSlot: 'A' } });
            await processMsg({ _id: 'lead-123' }, 'ok');
            expect(mockIncrementRetry).toHaveBeenCalled();
        });
    });

    // ─────────────────────────────
    // CONFIRM_BOOKING — crítico
    // ─────────────────────────────
    describe('ESTADO CONFIRM_BOOKING', () => {
        it('"sim" → chama autoBookAppointment com slot real (não letra)', async () => {
            currentLeadState = makeLead({
                currentState: 'CONFIRM_BOOKING',
                stateData: { chosenSlot: 'A', patientName: 'João Pedro' },
                therapyArea: 'fonoaudiologia',
                phone: '5562999990000',
                pendingSchedulingSlots: MOCK_SLOTS,
            });

            const result = await processMsg({ _id: 'lead-123' }, 'sim');

            expect(result.command).toBe('SEND_MESSAGE');
            expect(result.payload.text).toContain('confirmado');

            // Aguarda fire-and-forget
            await new Promise(r => setTimeout(r, 50));

            expect(mockAutoBookAppointment).toHaveBeenCalledWith(
                expect.objectContaining({
                    chosenSlot: SLOT_A, // objeto real, não 'A'
                    patientInfo: expect.objectContaining({ fullName: 'João Pedro' }),
                })
            );
        });

        it('"sim" com slot B → busca índice 1 da lista', async () => {
            currentLeadState = makeLead({
                currentState: 'CONFIRM_BOOKING',
                stateData: { chosenSlot: 'B', patientName: 'Ana Lima' },
                pendingSchedulingSlots: MOCK_SLOTS,
            });
            await processMsg({ _id: 'lead-123' }, 'confirma');

            await new Promise(r => setTimeout(r, 50));

            expect(mockAutoBookAppointment).toHaveBeenCalledWith(
                expect.objectContaining({ chosenSlot: SLOT_B })
            );
        });

        it('slot não encontrado (pendingSchedulingSlots vazio) → não chama autoBook, ainda confirma', async () => {
            currentLeadState = makeLead({
                currentState: 'CONFIRM_BOOKING',
                stateData: { chosenSlot: 'A', patientName: 'Carlos' },
                pendingSchedulingSlots: null,
            });
            const result = await processMsg({ _id: 'lead-123' }, 'sim');

            await new Promise(r => setTimeout(r, 50));

            expect(mockAutoBookAppointment).not.toHaveBeenCalled();
            expect(result.payload.text).toContain('confirmado'); // resposta ainda é enviada
        });

        it('"não" → limpa estado e cancela', async () => {
            currentLeadState = makeLead({ currentState: 'CONFIRM_BOOKING', stateData: { chosenSlot: 'A' } });
            const result = await processMsg({ _id: 'lead-123' }, 'não');
            expect(result.payload.text).toContain('Sem problema');
        });

        it('resposta ambígua → pede confirmação novamente', async () => {
            currentLeadState = makeLead({ currentState: 'CONFIRM_BOOKING', stateData: { chosenSlot: 'A' } });
            const result = await processMsg({ _id: 'lead-123' }, 'talvez');
            expect(result.payload.text).toMatch(/Sim|Não/i);
        });
    });

    // ─────────────────────────────
    // BOOKED
    // ─────────────────────────────
    describe('ESTADO BOOKED', () => {
        it('lead já agendado → responde que já está confirmado', async () => {
            currentLeadState = makeLead({ currentState: 'BOOKED', stateData: {} });
            const result = await processMsg({ _id: 'lead-123' }, 'oi');
            expect(result.payload.text).toContain('confirmado');
        });
    });

    // ─────────────────────────────
    // Interrupções globais
    // ─────────────────────────────
    describe('Interrupções globais (suspend/resume)', () => {
        it('pergunta de preço no meio do fluxo → suspende estado e responde', async () => {
            currentLeadState = makeLead({
                currentState: 'COLLECT_BIRTH',
                stateData: { therapy: 'speech' },
            });
            const result = await processMsg({ _id: 'lead-123' }, 'qual o preço da consulta?');

            expect(mockSuspendState).toHaveBeenCalledWith(
                'lead-123', 'COLLECT_BIRTH', expect.any(Object), 'PRICE_QUERY'
            );
            expect(result.payload.text).toMatch(/valor|avaliação|💰|preço/i);
        });

        it('pergunta de endereço no meio do fluxo → suspende e responde localização', async () => {
            currentLeadState = makeLead({ currentState: 'COLLECT_PERIOD', stateData: {} });
            const result = await processMsg({ _id: 'lead-123' }, 'onde fica a clínica?');

            expect(mockSuspendState).toHaveBeenCalled();
            expect(result.payload.text).toMatch(/Av\.|endereço|📍/i);
        });

        it('pergunta de preço no IDLE → NÃO suspende (não está em fluxo)', async () => {
            currentLeadState = makeLead({ currentState: null }); // IDLE
            await processMsg({ _id: 'lead-123' }, 'quanto custa?');
            expect(mockSuspendState).not.toHaveBeenCalled();
        });
    });

    // ─────────────────────────────
    // Fluxo completo de ponta a ponta
    // ─────────────────────────────
    describe('Fluxo completo E2E (sem DB real)', () => {
        it('IDLE → COLLECT_COMPLAINT → COLLECT_PERIOD → SHOW_SLOTS → COLLECT_PATIENT_DATA → CONFIRM_BOOKING → BOOKED', async () => {
            const leadId = 'lead-e2e';

            // Msg 1: primeiro contato com terapia
            currentLeadState = makeLead({ _id: leadId, currentState: null });
            let result = await processMsg({ _id: leadId }, 'quero fono');
            expect(result.command).toBe('SEND_MESSAGE');
            expect(mockJumpToState).toHaveBeenCalledWith(leadId, 'COLLECT_COMPLAINT', expect.objectContaining({ therapy: 'speech' }));
            vi.clearAllMocks();

            // Msg 2: queixa com idade
            currentLeadState = makeLead({ _id: leadId, currentState: 'COLLECT_COMPLAINT', stateData: { therapy: 'speech' }, therapyArea: 'fonoaudiologia' });
            result = await processMsg({ _id: leadId }, 'meu filho tem 5 anos e não fala');
            expect(mockJumpToState).toHaveBeenCalledWith(leadId, 'COLLECT_PERIOD', expect.any(Object));
            vi.clearAllMocks();

            // Msg 3: período
            currentLeadState = makeLead({ _id: leadId, currentState: 'COLLECT_PERIOD', stateData: { therapy: 'speech', age: { age: 5 } }, therapyArea: 'fonoaudiologia' });
            result = await processMsg({ _id: leadId }, 'manhã');
            expect(mockFindAvailableSlots).toHaveBeenCalledWith(expect.objectContaining({ therapyArea: 'fonoaudiologia' }));
            expect(mockPersistSchedulingSlots).toHaveBeenCalled();
            vi.clearAllMocks();

            // Msg 4: escolha de slot
            currentLeadState = makeLead({ _id: leadId, currentState: 'SHOW_SLOTS', stateData: { therapy: 'speech' } });
            result = await processMsg({ _id: leadId }, 'A');
            expect(mockJumpToState).toHaveBeenCalledWith(leadId, 'COLLECT_PATIENT_DATA', expect.objectContaining({ chosenSlot: 'A' }));
            vi.clearAllMocks();

            // Msg 5: nome
            currentLeadState = makeLead({ _id: leadId, currentState: 'COLLECT_PATIENT_DATA', stateData: { chosenSlot: 'A' } });
            result = await processMsg({ _id: leadId }, 'Lucas Oliveira');
            expect(mockJumpToState).toHaveBeenCalledWith(leadId, 'CONFIRM_BOOKING', expect.objectContaining({ patientName: 'Lucas Oliveira' }));
            vi.clearAllMocks();

            // Msg 6: confirmação
            currentLeadState = makeLead({
                _id: leadId,
                currentState: 'CONFIRM_BOOKING',
                stateData: { chosenSlot: 'A', patientName: 'Lucas Oliveira' },
                pendingSchedulingSlots: MOCK_SLOTS,
            });
            result = await processMsg({ _id: leadId }, 'sim');

            await new Promise(r => setTimeout(r, 50));

            expect(mockJumpToState).toHaveBeenCalledWith(leadId, 'BOOKED', expect.any(Object));
            expect(mockAutoBookAppointment).toHaveBeenCalledWith(
                expect.objectContaining({ chosenSlot: SLOT_A })
            );
            expect(result.payload.text).toContain('confirmado');
        });
    });
});
