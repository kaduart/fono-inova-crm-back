/**
 * Smoke tests do WhatsAppOrchestrator (real, não fake)
 *
 * Objetivo: capturar erros de import, função-não-encontrada e
 * crash precoce no process() — o tipo de bug que derrubou a
 * Amanda com "logDecision is not a function".
 *
 * NÃO testa lógica de negócio — para isso existem os testes de cenário.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks de infraestrutura (antes do import do orchestrator) ──────────────

vi.mock('../../models/Leads.js', () => ({
  default: {
    findById: vi.fn(),
    findByIdAndUpdate: vi.fn(),
    findOneAndUpdate: vi.fn(),
  },
}));

vi.mock('../../models/Message.js', () => ({
  default: {
    find: vi.fn().mockReturnValue({ sort: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }) }),
    create: vi.fn(),
  },
}));

vi.mock('../../infrastructure/persistence/LeadRepository.js', () => ({
  leadRepository: { findById: vi.fn(), update: vi.fn() },
}));

vi.mock('../../perception/PerceptionService.js', () => ({
  perceptionService: { analyze: vi.fn().mockResolvedValue({ estagio: 'frio', emocao: 'neutral', persona: 'Educadora' }) },
}));

vi.mock('../../services/amandaBookingService.js', () => ({
  findAvailableSlots: vi.fn().mockResolvedValue([]),
  autoBookAppointment: vi.fn(),
  buildSlotOptions: vi.fn().mockReturnValue(''),
}));

vi.mock('../../services/amandaLearningService.js', () => ({
  getLatestInsights: vi.fn().mockResolvedValue({ openings: [], priceResponses: [], closingQuestions: [] }),
}));

vi.mock('../../services/leadContext.js', () => ({
  enrichLeadContext: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../services/messageContextBuilder.js', () => ({
  buildMessageContext: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../services/IA/Aiproviderservice.js', () => ({
  callAI: vi.fn().mockResolvedValue('resposta mock da IA'),
}));

vi.mock('../../services/EnforcementLayer.js', () => ({
  enforce: vi.fn().mockImplementation((_, text) => text),
}));

vi.mock('../../services/whatsappLinkService.js', () => ({
  parseIncomingMessage: vi.fn().mockReturnValue({ text: '' }),
}));

vi.mock('../../utils/amandaPrompt.js', () => ({
  getSpecialHoursResponse: vi.fn().mockReturnValue(null),
  buildSystemPrompt: vi.fn().mockReturnValue(''),
  buildUserPrompt: vi.fn().mockReturnValue(''),
}));

vi.mock('../../utils/lpContextParser.js', () => ({
  extractLPContext: vi.fn().mockReturnValue(null),
}));

vi.mock('../../utils/flagsDetector.js', () => ({
  deriveFlagsFromText: vi.fn().mockReturnValue({
    mentionsUrgency: false, asksPrice: false, asksAvailability: false,
    mentionsInsurance: false, wantsToSchedule: false, isComplaint: false,
    mentionsChild: false, mentionsAdult: false, mentionsSelf: false,
    isGreeting: false, isFarewell: false, isConfirmation: false,
    isNegation: false, mentionsAge: false,
  }),
  detectMedicalSpecialty: vi.fn().mockReturnValue(null),
  validateServiceAvailability: vi.fn().mockReturnValue({ available: true }),
  MEDICAL_SPECIALTIES_MAP: {},
  resolveTopicFromFlags: vi.fn().mockReturnValue(null),
}));

vi.mock('../../services/utils/Logger.js', () => ({
  default: class MockLogger {
    info() {}
    warn() {}
    error() {}
    debug() {}
  },
}));

// ─── Módulos reais que queremos validar ─────────────────────────────────────

import { logDecision } from '../../orchestrators/decision/index.js';

// ─── Testes ─────────────────────────────────────────────────────────────────

describe('WhatsAppOrchestrator — smoke & import validation', () => {

  // ── 1. Validação de imports críticos ────────────────────────────────────

  describe('imports', () => {
    it('logDecision deve ser uma função (não undefined)', () => {
      expect(typeof logDecision).toBe('function');
    });

    it('WhatsAppOrchestrator deve ser importável sem erro', async () => {
      const mod = await import('../../orchestrators/WhatsAppOrchestrator.js');
      expect(mod.default).toBeDefined();
      expect(typeof mod.default).toBe('function'); // é uma classe
    });
  });

  // ── 2. Instanciação ──────────────────────────────────────────────────────

  describe('instanciação', () => {
    it('deve criar instância sem lançar exceção', async () => {
      const { default: WhatsAppOrchestrator } = await import('../../orchestrators/WhatsAppOrchestrator.js');
      expect(() => new WhatsAppOrchestrator()).not.toThrow();
    });
  });

  // ── 3. process() — smoke com lead mínimo ────────────────────────────────

  describe('process()', () => {
    let orchestrator;
    let Leads;

    beforeEach(async () => {
      const { default: WhatsAppOrchestrator } = await import('../../orchestrators/WhatsAppOrchestrator.js');
      orchestrator = new WhatsAppOrchestrator();

      // Lead mínimo que passa pelos guards iniciais
      const mockLead = {
        _id: 'lead-smoke-001',
        phone: '5511999999999',
        manualControl: { active: false },
        triageStep: null,
        currentState: 'IDLE',
        pendingPatientInfoForScheduling: false,
        pendingChosenSlot: false,
        qualificationData: {},
      };

      Leads = (await import('../../models/Leads.js')).default;
      Leads.findById.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockLead) });
    });

    it('não deve lançar TypeError em process() (eg. "logDecision is not a function")', async () => {
      const result = await orchestrator.process({
        lead: { _id: 'lead-smoke-001' },
        message: { content: 'Oi, quero saber sobre avaliação', from: '5511999999999' },
      });

      // Qualquer comando é válido — o que NÃO pode acontecer é TypeError
      expect(result).toHaveProperty('command');
    });

    it('deve retornar NO_REPLY quando lead não existe no banco', async () => {
      Leads.findById.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

      const result = await orchestrator.process({
        lead: { _id: 'lead-inexistente' },
        message: { content: 'Oi', from: '5511999999999' },
      });

      expect(result.command).toBe('NO_REPLY');
    });

    it('deve retornar NO_REPLY quando leadId está ausente', async () => {
      const result = await orchestrator.process({
        lead: {},
        message: { content: 'Oi', from: '5511999999999' },
      });

      expect(result.command).toBe('NO_REPLY');
    });
  });
});
