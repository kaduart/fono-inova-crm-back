/**
 * Testes de regressão — Bugs identificados nos logs de produção (2026-03-09)
 *
 * BUGS COBERTOS:
 *  [BUG-1] MongoServerError: autoBookingContext é null — _saveComplaint/_savePeriod falham
 *  [BUG-2] Lead retornando após gap — FSM reinicia do zero ignorando dados existentes
 *  [BUG-4] COLLECT_NAME ativado mesmo com patientInfo.fullName já no banco
 *  [BUG-7] COLLECT_PERIOD → pula para COLLECT_NAME mesmo com nome já existente
 *  [BUG-8] COLLECT_BIRTH recebe nome próprio e trata como data (birth_not_extracted)
 *  [BUG-10] "Neuropediatra" não reconhecido → retry genérico em vez de resposta contextual
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─────────────────────────────────────────────────────────────
// Helper: cria lead mock
// ─────────────────────────────────────────────────────────────
function makeLead(overrides = {}) {
    return {
        _id: 'lead-prod-001',
        currentState: 'IDLE',
        stateData: {},
        stateStack: [],
        retryCount: 0,
        therapyArea: null,
        phone: '5562999990000',
        patientInfo: {},
        autoBookingContext: null,  // null é o estado problemático do BUG-1
        pendingSchedulingSlots: null,
        lastInteractionAt: null,
        ...overrides,
    };
}

// ─────────────────────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────────────────────
const mockJumpToState    = vi.fn().mockResolvedValue({});
const mockIncrementRetry = vi.fn().mockResolvedValue({ count: 1, retryCount: 1, handoff: false });
const mockLeadsUpdateOne = vi.fn().mockResolvedValue({});

let currentLeadState = makeLead();
const mockLeadsFindById = vi.fn().mockImplementation(() => ({
    lean: vi.fn().mockResolvedValue(currentLeadState),
}));

vi.mock('../../models/Leads.js', () => ({
    default: {
        findById:          (...args) => mockLeadsFindById(...args),
        updateOne:         (...args) => mockLeadsUpdateOne(...args),
        findByIdAndUpdate: vi.fn().mockResolvedValue({}),
    },
}));

vi.mock('../../services/StateMachine.js', () => ({
    STATES: {
        IDLE: 'IDLE', GREETING: 'GREETING',
        COLLECT_THERAPY: 'COLLECT_THERAPY',
        COLLECT_NEURO_TYPE: 'COLLECT_NEURO_TYPE',
        COLLECT_NAME: 'COLLECT_NAME', COLLECT_BIRTH: 'COLLECT_BIRTH',
        COLLECT_COMPLAINT: 'COLLECT_COMPLAINT', COLLECT_PERIOD: 'COLLECT_PERIOD',
        SHOW_SLOTS: 'SHOW_SLOTS', CONFIRM_BOOKING: 'CONFIRM_BOOKING',
        COLLECT_PATIENT_DATA: 'COLLECT_PATIENT_DATA',
        BOOKED: 'BOOKED', INTERRUPTED: 'INTERRUPTED', HANDOFF: 'HANDOFF',
    },
    jumpToState:        (...args) => mockJumpToState(...args),
    suspendState:       vi.fn().mockResolvedValue({}),
    resumeState:        vi.fn().mockResolvedValue(null),
    incrementRetry:     (...args) => mockIncrementRetry(...args),
    advanceState:       vi.fn().mockResolvedValue({}),
    detectGlobalIntent: vi.fn().mockReturnValue(null),
    getResumeHint:      vi.fn(() => '💚 voltando ao agendamento...'),
    isAutoResume:       vi.fn().mockReturnValue(false),
}));

vi.mock('../../services/amandaBookingService.js', () => ({
    findAvailableSlots:  vi.fn().mockResolvedValue(null),
    autoBookAppointment: vi.fn().mockResolvedValue({ success: true }),
    buildSlotOptions:    vi.fn().mockReturnValue([]),
}));

vi.mock('../../infrastructure/persistence/LeadRepository.js', () => ({
    leadRepository: { persistSchedulingSlots: vi.fn().mockResolvedValue({}) },
}));

vi.mock('../../services/amandaLearningService.js', () => ({
    getLatestInsights: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../perception/PerceptionService.js', () => ({
    perceptionService: { analyze: vi.fn().mockResolvedValue(null) },
}));

vi.mock('../../config/pricing.js', () => ({
    PRICES: { avaliacaoInicial: 'R$ 200', sessaoAvulsa: 'R$ 130', neuropsicologica: 'R$ 1.700' },
    formatPrice: vi.fn((v) => `R$ ${v}`),
    getTherapyPricing: vi.fn().mockReturnValue({ avaliacao: 200, parcelamento: '6x sem juros' }),
}));

import WhatsAppOrchestrator from '../../orchestrators/WhatsAppOrchestrator.js';

let orchestrator;

beforeEach(() => {
    vi.clearAllMocks();
    orchestrator = new WhatsAppOrchestrator();
    currentLeadState = makeLead();
    mockLeadsFindById.mockImplementation(() => ({
        lean: vi.fn().mockResolvedValue(currentLeadState),
    }));
    mockIncrementRetry.mockResolvedValue({ count: 1, retryCount: 1, handoff: false });
    mockJumpToState.mockResolvedValue({});
    mockLeadsUpdateOne.mockResolvedValue({});
});

function makeMsg(content) {
    return { content, text: content, from: '5562999990000' };
}

// ═══════════════════════════════════════════════════════════════
// BUG-1: _saveComplaint e _savePeriod com autoBookingContext null
// ═══════════════════════════════════════════════════════════════
describe('[BUG-1] autoBookingContext null — updateOne com pipeline', () => {
    it('_saveComplaint deve usar pipeline (array) para não falhar com autoBookingContext null', async () => {
        currentLeadState = makeLead({
            currentState: 'COLLECT_COMPLAINT',
            autoBookingContext: null,
            therapyArea: 'fonoaudiologia',
        });

        const result = await orchestrator.process({
            lead: currentLeadState,
            message: makeMsg('Meu filho tem 3 anos e não fala nenhuma palavra ainda'),
        });

        expect(result.command).toBe('SEND_MESSAGE');

        // Verifica que updateOne foi chamado com um ARRAY (pipeline), não objeto simples
        const updateOneCalls = mockLeadsUpdateOne.mock.calls;
        const pipelineCalls = updateOneCalls.filter(call => Array.isArray(call[1]));
        expect(pipelineCalls.length, 'updateOne deve ter sido chamado com pipeline (array)').toBeGreaterThan(0);

        // Verifica que o pipeline inicializa autoBookingContext com $ifNull
        const hasSafeInit = pipelineCalls.some(call =>
            JSON.stringify(call[1]).includes('$ifNull')
        );
        expect(hasSafeInit, 'Pipeline deve conter $ifNull para inicializar autoBookingContext').toBe(true);
    });

    it('_savePeriod deve usar pipeline (array) para não falhar com autoBookingContext null', async () => {
        currentLeadState = makeLead({
            currentState: 'COLLECT_PERIOD',
            autoBookingContext: null,
            therapyArea: 'fonoaudiologia',
            stateData: { therapy: 'speech', complaint: 'atraso de fala' },
        });

        const result = await orchestrator.process({
            lead: currentLeadState,
            message: makeMsg('manhã'),
        });

        expect(result.command).toBe('SEND_MESSAGE');

        const updateOneCalls = mockLeadsUpdateOne.mock.calls;
        const pipelineCalls = updateOneCalls.filter(call => Array.isArray(call[1]));
        expect(pipelineCalls.length, 'savePeriod deve usar pipeline').toBeGreaterThan(0);

        const hasSafeInit = pipelineCalls.some(call =>
            JSON.stringify(call[1]).includes('$ifNull')
        );
        expect(hasSafeInit, 'Pipeline deve conter $ifNull para initializar autoBookingContext').toBe(true);
    });

    it('COLLECT_NEURO_TYPE laudo deve usar pipeline para salvar neuroType', async () => {
        currentLeadState = makeLead({
            currentState: 'COLLECT_NEURO_TYPE',
            autoBookingContext: null,
            therapyArea: 'neuropsicologia',
            stateData: { therapy: 'neuropsychological' },
        });

        const result = await orchestrator.process({
            lead: currentLeadState,
            message: makeMsg('laudo'),
        });

        expect(result.command).toBe('SEND_MESSAGE');
        expect(result.payload.text).toContain('R$ 1.700');

        const updateOneCalls = mockLeadsUpdateOne.mock.calls;
        const pipelineCalls = updateOneCalls.filter(call => Array.isArray(call[1]));
        expect(pipelineCalls.length, 'NEURO_TYPE deve usar pipeline').toBeGreaterThan(0);
    });
});

// ═══════════════════════════════════════════════════════════════
// BUG-2: Lead retornando após gap — IDLE com dados existentes
// ═══════════════════════════════════════════════════════════════
describe('[BUG-2] Lead retornando após gap — retomada contextual', () => {
    it('IDLE com therapyArea + complaint existentes → pular para COLLECT_PERIOD', async () => {
        currentLeadState = makeLead({
            currentState: 'IDLE',
            therapyArea: 'fonoaudiologia',
            autoBookingContext: { complaint: 'atraso de fala' },
            patientInfo: {},
        });

        const result = await orchestrator.process({
            lead: currentLeadState,
            message: makeMsg('Oi, voltei'),
        });

        expect(result.command).toBe('SEND_MESSAGE');
        // Deve retomar no COLLECT_PERIOD, não reiniciar do zero
        const jumpCall = mockJumpToState.mock.calls.find(c => c[1] === 'COLLECT_PERIOD');
        expect(jumpCall, 'Deve ter ido para COLLECT_PERIOD (retomada)').toBeTruthy();

        // NÃO deve ter ido para COLLECT_THERAPY (reinício do zero)
        const wrongJump = mockJumpToState.mock.calls.find(c => c[1] === 'COLLECT_THERAPY');
        expect(wrongJump, 'NÃO deve reiniciar em COLLECT_THERAPY').toBeFalsy();
    });

    it('IDLE com therapyArea + nome existentes → pular direto para SHOW_SLOTS', async () => {
        currentLeadState = makeLead({
            currentState: 'IDLE',
            therapyArea: 'fonoaudiologia',
            autoBookingContext: { complaint: 'atraso de fala', preferredPeriod: 'manha' },
            patientInfo: { fullName: 'Matias Portela Silva' },
        });

        const result = await orchestrator.process({
            lead: currentLeadState,
            message: makeMsg('Oi, voltei pra marcar'),
        });

        expect(result.command).toBe('SEND_MESSAGE');
        // Deve ir para SHOW_SLOTS pois já tem todos os dados
        const jumpCall = mockJumpToState.mock.calls.find(c => c[1] === 'SHOW_SLOTS');
        expect(jumpCall, 'Deve ter ido para SHOW_SLOTS').toBeTruthy();
    });

    it('IDLE com therapyArea mas sem complaint → retomar em COLLECT_COMPLAINT', async () => {
        currentLeadState = makeLead({
            currentState: 'IDLE',
            therapyArea: 'psicologia',
            autoBookingContext: null,
            patientInfo: {},
        });

        const result = await orchestrator.process({
            lead: currentLeadState,
            message: makeMsg('Oi voltei'),
        });

        expect(result.command).toBe('SEND_MESSAGE');
        const jumpCall = mockJumpToState.mock.calls.find(c => c[1] === 'COLLECT_COMPLAINT');
        expect(jumpCall, 'Deve ter ido para COLLECT_COMPLAINT').toBeTruthy();

        // Mensagem deve mencionar retomada (não saudação de novo lead)
        expect(result.payload.text).toMatch(/voltou|retornando|bem-vindo.a. de volta/i);
    });

    it('COLLECT_THERAPY com therapyArea já no banco → usar dado existente sem perguntar de novo', async () => {
        currentLeadState = makeLead({
            currentState: 'COLLECT_THERAPY',
            therapyArea: 'fonoaudiologia',
            patientInfo: {},
        });

        const result = await orchestrator.process({
            lead: currentLeadState,
            message: makeMsg('Oi, voltei'),  // texto sem terapia detectável
        });

        expect(result.command).toBe('SEND_MESSAGE');
        // Deve ter avançado para COLLECT_COMPLAINT usando therapyArea existente
        const jumpCall = mockJumpToState.mock.calls.find(c => c[1] === 'COLLECT_COMPLAINT');
        expect(jumpCall, 'Deve avançar para COLLECT_COMPLAINT usando dado existente').toBeTruthy();

        // NÃO deve ter ficado em loop pedindo terapia de novo
        const retryCall = mockIncrementRetry.mock.calls.length;
        expect(retryCall, 'NÃO deve ter incrementado retry se therapyArea já existe').toBe(0);
    });
});

// ═══════════════════════════════════════════════════════════════
// BUG-4: COLLECT_NAME com nome já existente no banco
// ═══════════════════════════════════════════════════════════════
describe('[BUG-4] COLLECT_NAME — nome já existe no banco', () => {
    it('deve pular COLLECT_NAME e ir para SHOW_SLOTS quando patientInfo.fullName existe', async () => {
        currentLeadState = makeLead({
            currentState: 'COLLECT_NAME',
            therapyArea: 'fonoaudiologia',
            patientInfo: { fullName: 'Matias Portela Silva' },
            stateData: { therapy: 'speech', complaint: 'atraso de fala', period: 'manha' },
        });

        const result = await orchestrator.process({
            lead: currentLeadState,
            message: makeMsg('Meu filho tem 1 ano e 10 meses e ainda não fala'),
        });

        expect(result.command).toBe('SEND_MESSAGE');
        // Deve ter ido para SHOW_SLOTS, não pedido o nome de novo
        const jumpCall = mockJumpToState.mock.calls.find(c => c[1] === 'SHOW_SLOTS');
        expect(jumpCall, 'Deve ter ido para SHOW_SLOTS').toBeTruthy();

        // NÃO deve ter pedido o nome
        expect(result.payload.text).not.toMatch(/nome completo do paciente/i);
        expect(result.payload.text).not.toMatch(/qual o nome/i);
    });
});

// ═══════════════════════════════════════════════════════════════
// BUG-7: COLLECT_PERIOD → STATE_JUMPED para COLLECT_NAME desnecessário
// ═══════════════════════════════════════════════════════════════
describe('[BUG-7] COLLECT_PERIOD → COLLECT_NAME com nome já existente', () => {
    it('deve pular COLLECT_NAME e ir direto para SHOW_SLOTS quando nome já existe no banco', async () => {
        currentLeadState = makeLead({
            currentState: 'COLLECT_PERIOD',
            therapyArea: 'fonoaudiologia',
            patientInfo: { fullName: 'Matias Portela Silva' },
            autoBookingContext: { complaint: 'atraso de fala' },
            stateData: { therapy: 'speech', complaint: 'atraso de fala' },
        });

        const result = await orchestrator.process({
            lead: currentLeadState,
            message: makeMsg('manhã'),
        });

        expect(result.command).toBe('SEND_MESSAGE');

        // Deve ter ido para SHOW_SLOTS, saltando COLLECT_NAME
        const jumpToShowSlots = mockJumpToState.mock.calls.find(c => c[1] === 'SHOW_SLOTS');
        expect(jumpToShowSlots, 'Deve ter ido para SHOW_SLOTS').toBeTruthy();

        // NÃO deve ter ido para COLLECT_NAME
        const jumpToCollectName = mockJumpToState.mock.calls.find(c => c[1] === 'COLLECT_NAME');
        expect(jumpToCollectName, 'NÃO deve ter ido para COLLECT_NAME').toBeFalsy();

        // NÃO deve perguntar pelo nome
        expect(result.payload.text).not.toMatch(/nome completo do paciente/i);
    });

    it('deve ir para COLLECT_NAME normalmente quando nome NÃO existe no banco', async () => {
        currentLeadState = makeLead({
            currentState: 'COLLECT_PERIOD',
            therapyArea: 'fonoaudiologia',
            patientInfo: {},  // sem nome
            autoBookingContext: { complaint: 'atraso de fala' },
            stateData: { therapy: 'speech', complaint: 'atraso de fala' },
        });

        const result = await orchestrator.process({
            lead: currentLeadState,
            message: makeMsg('tarde'),
        });

        expect(result.command).toBe('SEND_MESSAGE');

        // Deve ir para COLLECT_NAME pois não tem nome
        const jumpCall = mockJumpToState.mock.calls.find(c => c[1] === 'COLLECT_NAME');
        expect(jumpCall, 'Deve ter ido para COLLECT_NAME quando não tem nome').toBeTruthy();

        expect(result.payload.text).toMatch(/nome completo do paciente/i);
    });
});

// ═══════════════════════════════════════════════════════════════
// BUG-8: COLLECT_BIRTH recebe nome próprio
// ═══════════════════════════════════════════════════════════════
describe('[BUG-8] COLLECT_BIRTH recebe nome próprio ao invés de data', () => {
    it('deve detectar nome próprio e salvar sem pedir retry de data', async () => {
        currentLeadState = makeLead({
            currentState: 'COLLECT_BIRTH',
            therapyArea: 'fonoaudiologia',
            stateData: { therapy: 'speech', complaint: 'atraso de fala' },
        });

        const result = await orchestrator.process({
            lead: currentLeadState,
            message: makeMsg('Luna Yohanna Cordeiro Rodrigues'),
        });

        expect(result.command).toBe('SEND_MESSAGE');

        // Deve ter salvo o nome (updateOne com fullName)
        const nameUpdate = mockLeadsUpdateOne.mock.calls.find(call =>
            JSON.stringify(call[1]).includes('fullName')
        );
        expect(nameUpdate, 'Deve ter chamado updateOne para salvar patientInfo.fullName').toBeTruthy();

        // Deve pedir a data de nascimento (não erro genérico de retry)
        expect(result.payload.text).toMatch(/data de nascimento/i);
        expect(result.payload.text).not.toMatch(/preciso só da idade|Preciso só da/i);
    });

    it('deve detectar nome próprio de 2 palavras', async () => {
        currentLeadState = makeLead({
            currentState: 'COLLECT_BIRTH',
            stateData: { therapy: 'speech' },
        });

        const result = await orchestrator.process({
            lead: currentLeadState,
            message: makeMsg('Maria Clara'),
        });

        expect(result.command).toBe('SEND_MESSAGE');

        const nameUpdate = mockLeadsUpdateOne.mock.calls.find(call =>
            JSON.stringify(call[1]).includes('fullName')
        );
        expect(nameUpdate, 'Deve ter salvado o nome').toBeTruthy();
    });

    it('data de nascimento real NÃO deve ser tratada como nome', async () => {
        currentLeadState = makeLead({
            currentState: 'COLLECT_BIRTH',
            stateData: { therapy: 'speech' },
        });

        const result = await orchestrator.process({
            lead: currentLeadState,
            message: makeMsg('15/03/2020'),
        });

        expect(result.command).toBe('SEND_MESSAGE');

        // NÃO deve ter chamado updateOne com fullName
        const nameUpdate = mockLeadsUpdateOne.mock.calls.find(call =>
            JSON.stringify(call[1]).includes('fullName')
        );
        expect(nameUpdate, 'data real NÃO deve salvar como nome').toBeFalsy();

        // Deve ter avançado para COLLECT_PERIOD
        const jumpCall = mockJumpToState.mock.calls.find(c => c[1] === 'COLLECT_PERIOD');
        expect(jumpCall, 'Deve ter ido para COLLECT_PERIOD').toBeTruthy();
    });

    it('texto com número NÃO deve ser tratado como nome próprio', async () => {
        currentLeadState = makeLead({
            currentState: 'COLLECT_BIRTH',
            stateData: { therapy: 'speech' },
        });

        const result = await orchestrator.process({
            lead: currentLeadState,
            message: makeMsg('Pedro 7 anos'),
        });

        expect(result.command).toBe('SEND_MESSAGE');

        // Texto com número deve ser tratado como dado de idade, não nome puro
        const nameUpdate = mockLeadsUpdateOne.mock.calls.find(call =>
            JSON.stringify(call[1]).includes('fullName')
        );
        // Se tiver número, não deve ser salvo como nome puro
        expect(nameUpdate, 'Texto com número NÃO deve ser salvo como nome puro').toBeFalsy();
    });
});

// ═══════════════════════════════════════════════════════════════
// BUG-10: "Neuropediatra" não reconhecido em COLLECT_THERAPY
// ═══════════════════════════════════════════════════════════════
describe('[BUG-10] COLLECT_THERAPY — neuropediatra não é especialidade da clínica', () => {
    it('deve responder com mensagem explicativa (não retry genérico) quando lead diz "Neuropediatra"', async () => {
        currentLeadState = makeLead({ currentState: 'COLLECT_THERAPY' });

        const result = await orchestrator.process({
            lead: currentLeadState,
            message: makeMsg('Neuropediatra'),
        });

        expect(result.command).toBe('SEND_MESSAGE');

        // Deve mencionar que não oferece neuropediatria
        expect(result.payload.text).toMatch(/neuropediatria/i);

        // Deve sugerir Neuropsicologia como alternativa
        expect(result.payload.text).toMatch(/neuropsicologia/i);

        // NÃO deve ser a mensagem genérica de retry
        expect(result.payload.text).not.toBe('Hmm, não consegui identificar a especialidade 🤔\n\nTrabalhamos com Fono, Psico, Fisioterapia, Psicopedagogia, Musicoterapia e Neuropsico.\n\nQual dessas você procura?');
    });

    it('deve funcionar também com "neuropediatria" (escrita completa)', async () => {
        currentLeadState = makeLead({ currentState: 'COLLECT_THERAPY' });

        const result = await orchestrator.process({
            lead: currentLeadState,
            message: makeMsg('Quero consulta com neuropediatria'),
        });

        expect(result.command).toBe('SEND_MESSAGE');
        expect(result.payload.text).toMatch(/neuropediatria/i);
        expect(result.payload.text).toMatch(/neuropsicologia/i);
    });

    it('deve funcionar com "neuro pediatra" (com espaço)', async () => {
        currentLeadState = makeLead({ currentState: 'COLLECT_THERAPY' });

        const result = await orchestrator.process({
            lead: currentLeadState,
            message: makeMsg('neuro pediatra'),
        });

        expect(result.command).toBe('SEND_MESSAGE');
        expect(result.payload.text).toMatch(/neuropediatria/i);
    });

    it('Neuropsicologia real ainda deve ser detectada normalmente', async () => {
        currentLeadState = makeLead({ currentState: 'COLLECT_THERAPY' });

        const result = await orchestrator.process({
            lead: currentLeadState,
            message: makeMsg('Neuropsicologia'),
        });

        expect(result.command).toBe('SEND_MESSAGE');

        // Deve ter ido para COLLECT_NEURO_TYPE (não erroneamente respondido como neuropediatria)
        const jumpCall = mockJumpToState.mock.calls.find(c => c[1] === 'COLLECT_NEURO_TYPE');
        expect(jumpCall, 'Neuropsicologia real deve ir para COLLECT_NEURO_TYPE').toBeTruthy();

        // NÃO deve mencionar "não oferecemos neuropediatria"
        expect(result.payload.text).not.toMatch(/não oferecemos neuropediatria/i);
    });
});
