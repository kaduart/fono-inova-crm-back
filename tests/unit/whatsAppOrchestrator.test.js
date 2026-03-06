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
        it('aceita queixa e extrai idade → vai para COLLECT_BIRTH (data de nasc. obrigatória)', async () => {
            currentLeadState = makeLead({
                currentState: 'COLLECT_COMPLAINT',
                stateData: { therapy: 'speech' },
                therapyArea: 'fonoaudiologia',
            });
            const result = await processMsg({ _id: 'lead-123' }, 'meu filho não fala, tem 5 anos');

            expect(result.command).toBe('SEND_MESSAGE');
            // Mesmo com idade, vai para COLLECT_BIRTH para coletar data de nascimento
            const jumpCall = mockJumpToState.mock.calls.find(c => c[1] === 'COLLECT_BIRTH');
            expect(jumpCall).toBeTruthy();
            expect(jumpCall[2].age).toBeTruthy(); // idade foi salva
            expect(jumpCall[2].complaint).toBeTruthy();
            expect(result.payload.text).toMatch(/data de nascimento/i);
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

        it('fluxo multi-turn: fono → queixa sem idade → data de nascimento → período → nome → slots', async () => {
            const leadId = 'lead-3777';
            let result;
            vi.clearAllMocks();

            // Turn 1: queixa detectada, sem idade → COLLECT_BIRTH
            currentLeadState = makeLead({ _id: leadId, currentState: 'COLLECT_COMPLAINT', stateData: { therapy: 'speech' }, therapyArea: 'fonoaudiologia' });
            result = await processMsg({ _id: leadId }, 'minha filha tem problema para falar');
            expect(mockJumpToState).toHaveBeenCalledWith(leadId, 'COLLECT_BIRTH', expect.any(Object));
            vi.clearAllMocks();

            // Turn 2: usuário manda data → COLLECT_PERIOD
            currentLeadState = makeLead({ _id: leadId, currentState: 'COLLECT_BIRTH', stateData: { therapy: 'speech' }, therapyArea: 'fonoaudiologia' });
            result = await processMsg({ _id: leadId }, '28/11/2015');
            expect(mockJumpToState).toHaveBeenCalledWith(leadId, 'COLLECT_PERIOD', expect.objectContaining({ birthDate: '2015-11-28' }));
            vi.clearAllMocks();

            // Turn 3: período → COLLECT_NAME (pede nome, não busca slots ainda)
            currentLeadState = makeLead({ _id: leadId, currentState: 'COLLECT_PERIOD', stateData: { therapy: 'speech', birthDate: '2015-11-28' }, therapyArea: 'fonoaudiologia' });
            result = await processMsg({ _id: leadId }, 'manhã');
            expect(mockJumpToState).toHaveBeenCalledWith(leadId, 'COLLECT_NAME', expect.objectContaining({ period: expect.any(String) }));
            expect(mockFindAvailableSlots).not.toHaveBeenCalled(); // ainda não buscou slots
            vi.clearAllMocks();

            // Turn 4: nome → busca slots → SHOW_SLOTS
            currentLeadState = makeLead({ _id: leadId, currentState: 'COLLECT_NAME', stateData: { therapy: 'speech', period: 'manha' }, therapyArea: 'fonoaudiologia' });
            result = await processMsg({ _id: leadId }, 'Sofia Lima');
            expect(mockFindAvailableSlots).toHaveBeenCalledWith(expect.objectContaining({ therapyArea: 'fonoaudiologia' }));
            expect(mockPersistSchedulingSlots).toHaveBeenCalled();
            expect(mockJumpToState).toHaveBeenCalledWith(leadId, 'SHOW_SLOTS', expect.objectContaining({ patientName: 'Sofia Lima' }));
        });
    });

    // ─────────────────────────────
    // COLLECT_PERIOD
    // ─────────────────────────────
    describe('ESTADO COLLECT_PERIOD', () => {
        it('extrai período e vai para COLLECT_NAME (pede nome do paciente)', async () => {
            currentLeadState = makeLead({
                currentState: 'COLLECT_PERIOD',
                stateData: { therapy: 'speech', complaint: 'atraso fala', age: { age: 5 } },
                therapyArea: 'fonoaudiologia',
            });
            const result = await processMsg({ _id: 'lead-123' }, 'prefiro manhã');

            const jumpCall = mockJumpToState.mock.calls.find(c => c[1] === 'COLLECT_NAME');
            expect(jumpCall).toBeTruthy();
            expect(jumpCall[2].period).toBeTruthy();
            expect(result.payload.text).toMatch(/nome.*paciente|paciente.*nome/i);
            // NÃO deve ter chamado findAvailableSlots ainda
            expect(mockFindAvailableSlots).not.toHaveBeenCalled();
        });

        it('período não detectado → retry', async () => {
            currentLeadState = makeLead({ currentState: 'COLLECT_PERIOD', stateData: { therapy: 'speech' } });
            await processMsg({ _id: 'lead-123' }, 'qualquer horário');
            expect(mockIncrementRetry).toHaveBeenCalled();
        });
    });

    // ─────────────────────────────
    // COLLECT_NAME (novo estado)
    // ─────────────────────────────
    describe('ESTADO COLLECT_NAME', () => {
        it('nome válido → chama findAvailableSlots e vai para SHOW_SLOTS', async () => {
            currentLeadState = makeLead({
                currentState: 'COLLECT_NAME',
                stateData: { therapy: 'speech', period: 'manha', age: { age: 5 } },
                therapyArea: 'fonoaudiologia',
            });
            const result = await processMsg({ _id: 'lead-123' }, 'Lucas Oliveira');

            const jumpCall = mockJumpToState.mock.calls.find(c => c[1] === 'SHOW_SLOTS');
            expect(jumpCall).toBeTruthy();
            expect(jumpCall[2].patientName).toBe('Lucas Oliveira');
            expect(mockFindAvailableSlots).toHaveBeenCalled();
            expect(mockPersistSchedulingSlots).toHaveBeenCalledWith('lead-123', MOCK_SLOTS);
            expect(result.payload.text).toMatch(/A\)|opção|funciona/i);
        });

        it('findAvailableSlots usa lead.therapyArea como string', async () => {
            currentLeadState = makeLead({
                currentState: 'COLLECT_NAME',
                stateData: { therapy: { id: 'speech', name: 'Fonoaudiologia' } },
                therapyArea: 'fonoaudiologia',
            });
            await processMsg({ _id: 'lead-123' }, 'Maria Silva');

            const callArgs = mockFindAvailableSlots.mock.calls[0]?.[0];
            expect(typeof callArgs?.therapyArea).toBe('string');
            expect(callArgs?.therapyArea).toBe('fonoaudiologia');
        });

        it('sem slots disponíveis → volta para COLLECT_PERIOD (não fica travado em SHOW_SLOTS)', async () => {
            mockFindAvailableSlots.mockResolvedValueOnce({ primary: null, alternativesSamePeriod: [], alternativesOtherPeriod: [] });
            currentLeadState = makeLead({
                currentState: 'COLLECT_NAME',
                stateData: { therapy: 'speech', period: 'manha' },
                therapyArea: 'fonoaudiologia',
            });
            const result = await processMsg({ _id: 'lead-123' }, 'Ana Lima');

            // Deve voltar para COLLECT_PERIOD, não ficar em SHOW_SLOTS
            const jumpBack = mockJumpToState.mock.calls.find(c => c[1] === 'COLLECT_PERIOD');
            expect(jumpBack).toBeTruthy();
            expect(result.payload.text).toMatch(/não encontrei|outro período/i);
        });

        it('texto sem nome válido → retry', async () => {
            currentLeadState = makeLead({ currentState: 'COLLECT_NAME', stateData: {} });
            await processMsg({ _id: 'lead-123' }, 'ok');
            expect(mockIncrementRetry).toHaveBeenCalled();
        });
    });

    // ─────────────────────────────
    // SHOW_SLOTS
    // ─────────────────────────────
    describe('ESTADO SHOW_SLOTS', () => {
        it('escolha A → vai direto para CONFIRM_BOOKING (nome já coletado antes)', async () => {
            currentLeadState = makeLead({
                currentState: 'SHOW_SLOTS',
                stateData: { therapy: 'speech', patientName: 'Lucas Oliveira' },
            });
            const result = await processMsg({ _id: 'lead-123' }, 'A');

            const jumpCall = mockJumpToState.mock.calls.find(c => c[1] === 'CONFIRM_BOOKING');
            expect(jumpCall).toBeTruthy();
            expect(jumpCall[2].chosenSlot).toBe('A');
            // Não deve pedir nome de novo (já foi coletado em COLLECT_NAME)
            expect(result.payload.text).not.toMatch(/nome.*paciente/i);
            expect(result.payload.text).toContain('Lucas Oliveira');
            expect(result.payload.text).toMatch(/confirmar|Sim|Não/i);
        });

        it('escolha B também aceita', async () => {
            currentLeadState = makeLead({
                currentState: 'SHOW_SLOTS',
                stateData: { patientName: 'Ana Lima' },
            });
            await processMsg({ _id: 'lead-123' }, 'B');
            const jumpCall = mockJumpToState.mock.calls.find(c => c[1] === 'CONFIRM_BOOKING');
            expect(jumpCall?.[2].chosenSlot).toBe('B');
        });

        it('letra inválida → retry', async () => {
            currentLeadState = makeLead({ currentState: 'SHOW_SLOTS', stateData: {} });
            await processMsg({ _id: 'lead-123' }, 'quero outro');
            expect(mockIncrementRetry).toHaveBeenCalled();
        });

        // Regressão: bug crítico — sem slots → usuário travado em SHOW_SLOTS respondendo "tarde"
        it('REGRESSÃO: "tarde" em SHOW_SLOTS quando não há slots → não trava (era o bug real)', async () => {
            // Estado SHOW_SLOTS sem slots (porque no-slots-found mantinha estado SHOW_SLOTS)
            currentLeadState = makeLead({ currentState: 'SHOW_SLOTS', stateData: {} });
            const result = await processMsg({ _id: 'lead-123' }, 'tarde');
            // "tarde" não é A-F → retry, mas ao menos não quebra
            expect(result.command).toBe('SEND_MESSAGE');
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
        it('IDLE → COLLECT_COMPLAINT → COLLECT_BIRTH → COLLECT_PERIOD → COLLECT_NAME → SHOW_SLOTS → CONFIRM_BOOKING → BOOKED', async () => {
            const leadId = 'lead-e2e';

            // Msg 1: primeiro contato com terapia
            currentLeadState = makeLead({ _id: leadId, currentState: null });
            let result = await processMsg({ _id: leadId }, 'quero fono');
            expect(result.command).toBe('SEND_MESSAGE');
            expect(mockJumpToState).toHaveBeenCalledWith(leadId, 'COLLECT_COMPLAINT', expect.objectContaining({ therapy: 'speech' }));
            vi.clearAllMocks();

            // Msg 2: queixa com idade → COLLECT_BIRTH (mesmo com idade, precisa data de nasc.)
            currentLeadState = makeLead({ _id: leadId, currentState: 'COLLECT_COMPLAINT', stateData: { therapy: 'speech' }, therapyArea: 'fonoaudiologia' });
            result = await processMsg({ _id: leadId }, 'meu filho tem 5 anos e não fala');
            expect(mockJumpToState).toHaveBeenCalledWith(leadId, 'COLLECT_BIRTH', expect.objectContaining({ age: expect.any(Object) }));
            vi.clearAllMocks();

            // Msg 3: data de nascimento → COLLECT_PERIOD
            currentLeadState = makeLead({ _id: leadId, currentState: 'COLLECT_BIRTH', stateData: { therapy: 'speech', complaint: '...', age: { age: 5 } }, therapyArea: 'fonoaudiologia' });
            result = await processMsg({ _id: leadId }, '10/03/2020');
            expect(mockJumpToState).toHaveBeenCalledWith(leadId, 'COLLECT_PERIOD', expect.objectContaining({ birthDate: '2020-03-10' }));
            vi.clearAllMocks();

            // Msg 4: período → COLLECT_NAME (pede nome, sem buscar slots)
            currentLeadState = makeLead({ _id: leadId, currentState: 'COLLECT_PERIOD', stateData: { therapy: 'speech', birthDate: '2020-03-10' }, therapyArea: 'fonoaudiologia' });
            result = await processMsg({ _id: leadId }, 'manhã');
            expect(mockJumpToState).toHaveBeenCalledWith(leadId, 'COLLECT_NAME', expect.any(Object));
            expect(mockFindAvailableSlots).not.toHaveBeenCalled();
            expect(result.payload.text).toMatch(/nome.*paciente/i);
            vi.clearAllMocks();

            // Msg 5: nome → busca slots → SHOW_SLOTS
            currentLeadState = makeLead({ _id: leadId, currentState: 'COLLECT_NAME', stateData: { therapy: 'speech', period: 'manha', birthDate: '2020-03-10' }, therapyArea: 'fonoaudiologia' });
            result = await processMsg({ _id: leadId }, 'Lucas Oliveira');
            expect(mockFindAvailableSlots).toHaveBeenCalled();
            expect(mockPersistSchedulingSlots).toHaveBeenCalled();
            expect(mockJumpToState).toHaveBeenCalledWith(leadId, 'SHOW_SLOTS', expect.objectContaining({ patientName: 'Lucas Oliveira' }));
            expect(result.payload.text).toMatch(/A\)|opção/i);
            vi.clearAllMocks();

            // Msg 6: escolha de slot → CONFIRM_BOOKING (com nome já no stateData)
            currentLeadState = makeLead({ _id: leadId, currentState: 'SHOW_SLOTS', stateData: { therapy: 'speech', patientName: 'Lucas Oliveira' } });
            result = await processMsg({ _id: leadId }, 'A');
            expect(mockJumpToState).toHaveBeenCalledWith(leadId, 'CONFIRM_BOOKING', expect.objectContaining({ chosenSlot: 'A', patientName: 'Lucas Oliveira' }));
            expect(result.payload.text).toContain('Lucas Oliveira');
            vi.clearAllMocks();

            // Msg 7: confirmação → BOOKED
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

    // ─────────────────────────────────────────────────────
    // Regressão — Bugs identificados na screenshot 06/03/2026
    // ─────────────────────────────────────────────────────
    describe('Regressão — Bugs da screenshot (06/03/2026)', () => {
        it('BUG 1: queixa com idade → não pula para COLLECT_PERIOD (data de nasc. obrigatória)', async () => {
            currentLeadState = makeLead({
                currentState: 'COLLECT_COMPLAINT',
                stateData: { therapy: 'speech' },
            });
            await processMsg({ _id: 'lead-123' }, 'meu filho nao ta comendo direito, 2 anos');

            // NUNCA deve pular para COLLECT_PERIOD direto — deve ir para COLLECT_BIRTH
            const jumpPeriod = mockJumpToState.mock.calls.find(c => c[1] === 'COLLECT_PERIOD');
            expect(jumpPeriod).toBeFalsy();
            const jumpBirth = mockJumpToState.mock.calls.find(c => c[1] === 'COLLECT_BIRTH');
            expect(jumpBirth).toBeTruthy();
        });

        it('BUG 2: sem slots para "manha" → volta para COLLECT_PERIOD (usuário pode responder "tarde")', async () => {
            mockFindAvailableSlots.mockResolvedValueOnce({ primary: null, alternativesSamePeriod: [], alternativesOtherPeriod: [] });
            currentLeadState = makeLead({
                currentState: 'COLLECT_NAME',
                stateData: { therapy: 'speech', period: 'manha' },
                therapyArea: 'fonoaudiologia',
            });
            await processMsg({ _id: 'lead-123' }, 'Maria Silva');

            // Estado deve voltar para COLLECT_PERIOD (não ficar em SHOW_SLOTS)
            const jumpBack = mockJumpToState.mock.calls.find(c => c[1] === 'COLLECT_PERIOD');
            expect(jumpBack).toBeTruthy();

            // Agora simula o usuário respondendo "tarde" — deve funcionar
            vi.clearAllMocks();
            mockFindAvailableSlots.mockResolvedValueOnce(MOCK_SLOTS); // tarde tem slots
            currentLeadState = makeLead({
                currentState: 'COLLECT_PERIOD',
                stateData: { therapy: 'speech', patientName: 'Maria Silva' },
                therapyArea: 'fonoaudiologia',
            });
            const result = await processMsg({ _id: 'lead-123' }, 'tarde');
            // Deve ir para COLLECT_NAME (pede nome de novo? não, já tem no stateData)
            // Na prática vai para COLLECT_NAME porque o período mudou
            const jumpName = mockJumpToState.mock.calls.find(c => c[1] === 'COLLECT_NAME');
            expect(jumpName).toBeTruthy();
        });

        it('BUG 3: nome coletado ANTES dos slots (COLLECT_NAME existe no fluxo)', async () => {
            // Verifica que COLLECT_PERIOD → COLLECT_NAME (não → SHOW_SLOTS direto)
            currentLeadState = makeLead({
                currentState: 'COLLECT_PERIOD',
                stateData: { therapy: 'speech', birthDate: '2020-03-10' },
                therapyArea: 'fonoaudiologia',
            });
            const result = await processMsg({ _id: 'lead-123' }, 'tarde');

            const jumpCollectName = mockJumpToState.mock.calls.find(c => c[1] === 'COLLECT_NAME');
            expect(jumpCollectName).toBeTruthy();

            const jumpShowSlots = mockJumpToState.mock.calls.find(c => c[1] === 'SHOW_SLOTS');
            expect(jumpShowSlots).toBeFalsy(); // sem pular para SHOW_SLOTS ainda
        });

        it('BOOKED: "precisa remarcar" → limpa estado e reinicia fluxo', async () => {
            currentLeadState = makeLead({ currentState: 'BOOKED', stateData: {} });
            const result = await processMsg({ _id: 'lead-123' }, 'precisa remarcar');

            // Deve limpar estado (chamar updateOne com IDLE)
            expect(mockLeadsUpdateOne).toHaveBeenCalled();
            // Deve processar no IDLE (pedir terapia)
            const jumpTherapy = mockJumpToState.mock.calls.find(c => c[1] === 'COLLECT_THERAPY');
            expect(jumpTherapy).toBeTruthy();
        });
    });
});
