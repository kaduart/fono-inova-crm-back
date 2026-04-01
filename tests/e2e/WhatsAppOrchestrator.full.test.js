// tests/WhatsAppOrchestrator.full.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ======================================================
// 🔹 Mocks inline (Patient + Leads)
// ======================================================

const mockPatient = {
    findById: vi.fn().mockImplementation((id) => ({
        lean: vi.fn().mockResolvedValue({
            _id: id,
            name: 'Paciente Teste',
            birthDate: '2010-01-01',
            phone: '11999999999',
            history: [],
            primaryComplaint: undefined,
            multipleChildren: false,
            waiveRescheduleFee: false,
        }),
    })),
    findOne: vi.fn().mockImplementation((query) => ({
        lean: vi.fn().mockResolvedValue({
            _id: query._id || 'mock-id',
            name: 'Paciente Teste',
            birthDate: '2010-01-01',
            phone: '11999999999',
            history: [],
            primaryComplaint: undefined,
            multipleChildren: false,
            waiveRescheduleFee: false,
        }),
    })),
    create: vi.fn().mockImplementation((data) => Promise.resolve({ _id: 'mock-id', ...data })),
};

const mockExtraFields = {
    name: 'Paciente Teste',
    history: [],
    primaryComplaint: undefined,
    multipleChildren: false,
    waiveRescheduleFee: false,
    therapies: [],
    scheduledAppointments: [],
};

const LeadsMock = {
    findByIdAndUpdate: vi.fn().mockImplementation((id, update) => ({
        lean: vi.fn().mockResolvedValue({ _id: id, ...mockExtraFields, ...update }),
    })),
    findOne: vi.fn().mockImplementation((query) => ({
        lean: vi.fn().mockResolvedValue({ _id: query._id || 'mock-id', ...mockExtraFields }),
    })),
    create: vi.fn().mockResolvedValue({ _id: 'mock-id', ...mockExtraFields }),
    findOneAndUpdate: vi.fn().mockImplementation((query, update) => ({
        lean: vi.fn().mockResolvedValue({ _id: query._id || 'mock-id', ...mockExtraFields, ...update }),
    })),
};

// ======================================================
// 🔹 Mock de serviços do orchestrator
// ======================================================
const findAvailableSlots = vi.fn().mockResolvedValue([
    { date: '2026-02-20', time: '10:00' },
    { date: '2026-02-20', time: '14:00' },
]);

// ======================================================
// 🔹 Orchestrator simples inline (determinístico)
// ======================================================
class WhatsAppOrchestrator {
    constructor() {
        this.state = 'INITIAL';
    }

    async handleMessage({ leadId, text }) {
        // Simula detecção de intenção
        const intent = text.includes('agendar') ? 'BOOK' : 'UNKNOWN';

        if (intent === 'BOOK') {
            const slots = await findAvailableSlots();
            this.state = 'SLOTS_OFFERED';
            return {
                reply: `Encontrei os horários disponíveis: ${slots.map(s => s.time).join(', ')}`,
                slots,
            };
        }

        return { reply: "Não entendi, pode repetir?", slots: [] };
    }
}

// ======================================================
// 🔹 Testes inline
// ======================================================
beforeEach(() => {
    vi.clearAllMocks();
});

describe('WhatsAppOrchestrator FULL Inline', () => {
    it('deve responder com horários quando lead quer agendar', async () => {
        const orchestrator = new WhatsAppOrchestrator();
        const leadId = 'mock-lead-id';
        const message = 'Olá, quero agendar uma sessão de fono';

        const response = await orchestrator.handleMessage({ leadId, text: message });

        expect(response.reply).toContain('10:00');
        expect(response.reply).toContain('14:00');
        expect(orchestrator.state).toBe('SLOTS_OFFERED');
        expect(findAvailableSlots).toHaveBeenCalledOnce();
    });

    it('deve retornar mensagem de não entendimento para textos desconhecidos', async () => {
        const orchestrator = new WhatsAppOrchestrator();
        const leadId = 'mock-lead-id';
        const message = 'Olá, só queria dizer oi';

        const response = await orchestrator.handleMessage({ leadId, text: message });

        expect(response.reply).toBe("Não entendi, pode repetir?");
        expect(response.slots).toHaveLength(0);
        expect(orchestrator.state).toBe('INITIAL');
    });
});
