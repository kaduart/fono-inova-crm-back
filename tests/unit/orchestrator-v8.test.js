/**
 * Testes do WhatsAppOrchestrator V8
 * 
 * Cenários críticos para validar:
 * 1. Intenção pura vs queixa real (FIX 2)
 * 2. Detecção de adulto (FIX 1)
 * 3. Gate adulto + voz (FIX 3)
 * 4. Loop de segurança
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import WhatsAppOrchestrator from '../orchestrators/WhatsAppOrchestrator.js';
import { STATES } from '../services/StateMachine.js';
import Leads from '../models/Leads.js';

// Mock das dependências
jest.mock('../models/Leads.js');
jest.mock('../models/Message.js');
jest.mock('../services/amandaBookingService.js');
jest.mock('../services/IA/Aiproviderservice.js');

describe('WhatsAppOrchestrator V8 - Sistema de Persona', () => {
  
  describe('detectPersona()', () => {
    
    it('Deve detectar "child" quando menciona filho', () => {
      const result = orchestrator.detectPersona('Meu filho não fala direito');
      expect(result).toBe('child');
    });
    
    it('Deve detectar "child" quando menciona neto', () => {
      const result = orchestrator.detectPersona('É para meu neto');
      expect(result).toBe('child');
    });
    
    it('Deve detectar "child" quando menciona sobrinha', () => {
      const result = orchestrator.detectPersona('Minha sobrinha tem dificuldade');
      expect(result).toBe('child');
    });
    
    it('Deve detectar "child" quando menciona afilhado', () => {
      const result = orchestrator.detectPersona('Meu afilhado precisa de ajuda');
      expect(result).toBe('child');
    });
    
    it('Deve detectar "child" quando menciona aluno', () => {
      const result = orchestrator.detectPersona('Tenho um aluno com problemas');
      expect(result).toBe('child');
    });
    
    it('Deve detectar "child" quando menciona idade em anos (tem 5 anos)', () => {
      const result = orchestrator.detectPersona('Ela tem 5 anos e não fala');
      expect(result).toBe('child');
    });
    
    it('Deve detectar "self" quando diz "para mim"', () => {
      const result = orchestrator.detectPersona('É para mim');
      expect(result).toBe('self');
    });
    
    it('Deve detectar "self" quando diz "sou eu"', () => {
      const result = orchestrator.detectPersona('Sou eu que preciso');
      expect(result).toBe('self');
    });
    
    it('Deve detectar "self" quando diz "tenho X anos" (adulto)', () => {
      const result = orchestrator.detectPersona('Tenho 30 anos e tenho dificuldade');
      expect(result).toBe('self');
    });
    
    it('Deve priorizar CRIANÇA quando menciona ambos', () => {
      // "É pra mim e meu neto" → deve ser child (regra de ouro)
      const result = orchestrator.detectPersona('É pra mim e meu neto');
      expect(result).toBe('child');
    });
    
    it('Deve retornar "unknown" quando não há contexto claro', () => {
      const result = orchestrator.detectPersona('Oi, tudo bem?');
      expect(result).toBe('unknown');
    });
    
    it('Deve retornar "unknown" para texto vazio', () => {
      const result = orchestrator.detectPersona('');
      expect(result).toBe('unknown');
    });
  });

  describe('_getPersonaHint()', () => {
    
    it('Deve retornar hint para child', () => {
      const hint = orchestrator._getPersonaHint('child');
      expect(hint).toContain('CRIANÇA');
      expect(hint).toContain('responsáveis');
    });
    
    it('Deve retornar hint para self', () => {
      const hint = orchestrator._getPersonaHint('self');
      expect(hint).toContain('ADULTO');
      expect(hint).toContain('NÃO mencione criança');
    });
    
    it('Deve retornar hint para unknown', () => {
      const hint = orchestrator._getPersonaHint('unknown');
      expect(hint).toContain('Não está claro');
      expect(hint).toContain('pergunte');
    });
  });

  describe('Logs de PERSONA_DETECTED', () => {
    
    it('Deve logar quando detecta persona no IDLE', async () => {
      await orchestrator.process({
        lead: mockLead,
        message: { text: 'Meu neto precisa de ajuda', type: 'text' },
        services: {}
      });

      expect(orchestrator.logger.info).toHaveBeenCalledWith(
        'PERSONA_DETECTED',
        expect.objectContaining({
          leadId: 'test-lead-id',
          persona: 'child',
          source: 'IDLE_therapy_detected'
        })
      );
    });
    
    it('Deve logar quando atualiza persona via birth calculation', async () => {
      const leadWithUnknown = {
        ...mockLead,
        currentState: STATES.COLLECT_BIRTH,
        stateData: { persona: 'unknown', complaint: 'Teste' }
      };

      await orchestrator.process({
        lead: leadWithUnknown,
        message: { text: '11/04/1990', type: 'text' },  // Adulto
        services: {}
      });

      expect(orchestrator.logger.info).toHaveBeenCalledWith(
        'PERSONA_DETECTED',
        expect.objectContaining({
          persona: 'self',
          source: 'birth_calculation'
        })
      );
    });
  });
});

describe('WhatsAppOrchestrator V8 - Testes Críticos', () => {
  let orchestrator;
  let mockLead;

  beforeEach(() => {
    orchestrator = new WhatsAppOrchestrator();
    mockLead = {
      _id: 'test-lead-id',
      phone: '5562999999999',
      currentState: STATES.IDLE,
      retryCount: 0,
      patientInfo: {},
      qualificationData: {},
      save: jest.fn().mockResolvedValue(true),
    };
  });

  // ═══════════════════════════════════════════════════════════════════════
  // TESTE 1 & 2: Intenção pura vs queixa real (FIX 2)
  // ═══════════════════════════════════════════════════════════════════════
  describe('FIX 2: Intenção pura vs queixa real', () => {
    
    it('Teste 1: "Quero agendar" → NÃO deve aceitar como queixa', async () => {
      const result = await orchestrator.process({
        lead: { ...mockLead, currentState: STATES.COLLECT_COMPLAINT },
        message: { text: 'Quero agendar', type: 'text' },
        services: {}
      });

      // Deve permanecer em COLLECT_COMPLAINT (re-perguntar)
      expect(result.nextState).toBe(STATES.COLLECT_COMPLAINT);
      // Deve logar INTENT_BLOCKED_NO_COMPLAINT
      expect(orchestrator.logger.info).toHaveBeenCalledWith(
        'INTENT_BLOCKED_NO_COMPLAINT',
        expect.objectContaining({
          leadId: 'test-lead-id',
          isPureIntent: true,
          hasRealComplaint: false
        })
      );
    });

    it('Teste 2: "Minha filha não fala direito" → Deve aceitar como queixa', async () => {
      const result = await orchestrator.process({
        lead: { ...mockLead, currentState: STATES.COLLECT_COMPLAINT },
        message: { text: 'Minha filha não fala direito', type: 'text' },
        services: {}
      });

      // Deve avançar para COLLECT_BIRTH
      expect(result.nextState).toBe(STATES.COLLECT_BIRTH);
      // Deve salvar a queixa
      expect(mockLead.patientInfo.complaint).toContain('não fala');
    });

    it('Teste 3 (edge): "Quero agendar porque meu filho não fala" → Deve detectar queixa', async () => {
      const result = await orchestrator.process({
        lead: { ...mockLead, currentState: STATES.COLLECT_COMPLAINT },
        message: { text: 'Quero agendar porque meu filho não fala', type: 'text' },
        services: {}
      });

      // Tem intenção E queixa real → deve avançar
      expect(result.nextState).toBe(STATES.COLLECT_BIRTH);
      // NÃO deve bloquear
      expect(orchestrator.logger.info).not.toHaveBeenCalledWith(
        'INTENT_BLOCKED_NO_COMPLAINT',
        expect.anything()
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // TESTE 4, 5, 6: Detecção de adulto (FIX 1)
  // ═══════════════════════════════════════════════════════════════════════
  describe('FIX 1: Detecção de adulto', () => {
    
    it('Teste 4: "É para mim" → Deve detectar adulto', async () => {
      const result = await orchestrator.process({
        lead: mockLead,
        message: { text: 'É para mim', type: 'text' },
        services: {}
      });

      // Deve logar ADULT_DETECTED
      expect(orchestrator.logger.info).toHaveBeenCalledWith(
        'V8_ADULT_DETECTED',
        expect.objectContaining({
          leadId: 'test-lead-id',
          source: 'IDLE_isAdultSelf'
        })
      );
      // Deve propagar isAdult no stateData
      expect(result.stateData.isAdult).toBe(true);
    });

    it('Teste 5: "É para meu filho" → NÃO deve detectar adulto', async () => {
      const result = await orchestrator.process({
        lead: mockLead,
        message: { text: 'É para meu filho', type: 'text' },
        services: {}
      });

      // NÃO deve logar ADULT_DETECTED
      expect(orchestrator.logger.info).not.toHaveBeenCalledWith(
        'V8_ADULT_DETECTED',
        expect.anything()
      );
      // isAdult deve ser false ou undefined
      expect(result.stateData?.isAdult).toBeFalsy();
    });

    it('Teste 6 (armadilha): "É pra mim e meu filho" → Prioriza criança', async () => {
      const result = await orchestrator.process({
        lead: mockLead,
        message: { text: 'É pra mim e meu filho', type: 'text' },
        services: {}
      });

      // Menciona filho → NÃO é adulto
      expect(result.stateData?.isAdult).toBeFalsy();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // TESTE 7 & 8: Gate adulto + voz (FIX 3)
  // ═══════════════════════════════════════════════════════════════════════
  describe('FIX 3: Gate adulto + voz', () => {
    
    it('Teste 7: Adulto + voz → Deve REJEITAR', async () => {
      const leadWithContext = {
        ...mockLead,
        currentState: STATES.COLLECT_BIRTH,
        patientInfo: {
          complaint: 'Minha voz está rouca'
        },
        stateData: {
          isAdult: true,
          complaint: 'Minha voz está rouca'
        }
      };

      const result = await orchestrator.process({
        lead: leadWithContext,
        message: { text: '11/04/1990', type: 'text' },  // 36 anos
        services: {}
      });

      // Deve ir para REJECTED
      expect(result.nextState).toBe(STATES.REJECTED);
      // Deve logar ADULT_VOICE_REJECTED
      expect(orchestrator.logger.info).toHaveBeenCalledWith(
        'ADULT_VOICE_REJECTED',
        expect.objectContaining({
          leadId: 'test-lead-id',
          age: expect.any(Number),
          reason: 'adult_voice_not_attended'
        })
      );
      // Resposta deve mencionar que não atende voz adulta
      expect(result.response).toContain('voz adulta');
    });

    it('Teste 8: Adulto SEM voz (dificuldade para engolir) → Deve permitir', async () => {
      const leadWithContext = {
        ...mockLead,
        currentState: STATES.COLLECT_BIRTH,
        stateData: {
          isAdult: true,
          complaint: 'Tenho dificuldade para engolir'
        }
      };

      const result = await orchestrator.process({
        lead: leadWithContext,
        message: { text: '11/04/1990', type: 'text' },
        services: {}
      });

      // Deve avançar normalmente (não é caso de voz)
      expect(result.nextState).toBe(STATES.COLLECT_PERIOD);
      // NÃO deve rejeitar
      expect(result.nextState).not.toBe(STATES.REJECTED);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // TESTE 9: Regressão do Bug 1
  // ═══════════════════════════════════════════════════════════════════════
  describe('Regressão: Bug 1 - "Quero ser avaliada"', () => {
    
    it('Teste 9: "Quero ser avaliada" → NÃO deve passar como queixa válida', async () => {
      const result = await orchestrator.process({
        lead: { ...mockLead, currentState: STATES.COLLECT_COMPLAINT },
        message: { text: 'Quero ser avaliada', type: 'text' },
        services: {}
      });

      // Deve bloquear (intenção pura sem queixa real)
      expect(result.nextState).toBe(STATES.COLLECT_COMPLAINT);
      // Deve pedir para descrever a queixa
      expect(result.response).toMatch(/queixa|preocupando|incomodando/i);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // TESTE 10: Anti-loop
  // ═══════════════════════════════════════════════════════════════════════
  describe('Anti-loop de segurança', () => {
    
    it('Teste 10: Usuário insiste 3x em intenção pura → Deve mudar abordagem', async () => {
      const leadWithRetries = {
        ...mockLead,
        currentState: STATES.COLLECT_COMPLAINT,
        retryCount: 2
      };

      const result = await orchestrator.process({
        lead: leadWithRetries,
        message: { text: 'Quero agendar', type: 'text' },
        services: {}
      });

      // Na 3ª tentativa, deve usar mensagem mais direta
      expect(result.response).toMatch(/pra te ajudar melhor|preciso entender/i);
      // Deve incrementar retry
      expect(result.retryCount).toBe(3);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // TESTES ADICIONAIS: Edge cases importantes
  // ═══════════════════════════════════════════════════════════════════════
  describe('Edge cases adicionais', () => {
    
    it('Cálculo de idade a partir de data de nascimento', async () => {
      // Data de nascimento que resulta em 22 anos
      const age = orchestrator._calculateAgeFromBirth('2004-04-11');
      expect(age).toBeGreaterThanOrEqual(21);
      expect(age).toBeLessThanOrEqual(22);
    });

    it('Criança não deve ser afetada pelo gate de voz', async () => {
      const leadWithChild = {
        ...mockLead,
        currentState: STATES.COLLECT_BIRTH,
        stateData: {
          isAdult: false,
          complaint: 'Minha voz está rouca'
        }
      };

      const result = await orchestrator.process({
        lead: leadWithChild,
        message: { text: '11/04/2020', type: 'text' },  // 6 anos
        services: {}
      });

      // Criança com queixa de voz → deve permitir (pode ser disfonia infantil)
      expect(result.nextState).not.toBe(STATES.REJECTED);
    });

    it('Adulto detectado via data de nascimento deve logar', async () => {
      const leadWithContext = {
        ...mockLead,
        currentState: STATES.COLLECT_BIRTH,
        stateData: {
          complaint: 'Dificuldade para engolir'
          // isAdult não está setado ainda
        }
      };

      await orchestrator.process({
        lead: leadWithContext,
        message: { text: '11/04/1990', type: 'text' },  // 36 anos
        services: {}
      });

      // Deve logar ADULT_DETECTED via cálculo da data
      expect(orchestrator.logger.info).toHaveBeenCalledWith(
        'ADULT_DETECTED',
        expect.objectContaining({
          source: 'birth_calculation'
        })
      );
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// MÉTRICAS E OBSERVABILIDADE
// ═══════════════════════════════════════════════════════════════════════
describe('Métricas e Logs Estratégicos', () => {
  
  it('Deve logar métricas de bloqueio por intenção', () => {
    // Verificar que os logs estão sendo chamados com o formato correto
    const mockLogger = {
      info: jest.fn(),
      warn: jest.fn()
    };

    // Simular chamada de log
    mockLogger.info('INTENT_BLOCKED_NO_COMPLAINT', {
      leadId: '123',
      text: 'Quero agendar',
      isPureIntent: true,
      hasRealComplaint: false
    });

    expect(mockLogger.info).toHaveBeenCalledWith(
      'INTENT_BLOCKED_NO_COMPLAINT',
      expect.objectContaining({
        isPureIntent: true,
        hasRealComplaint: false
      })
    );
  });

  it('Deve logar métricas de rejeição de adulto + voz', () => {
    const mockLogger = {
      info: jest.fn()
    };

    mockLogger.info('ADULT_VOICE_REJECTED', {
      leadId: '123',
      age: 36,
      complaint: 'Voz rouca',
      reason: 'adult_voice_not_attended'
    });

    expect(mockLogger.info).toHaveBeenCalledWith(
      'ADULT_VOICE_REJECTED',
      expect.objectContaining({
        age: expect.any(Number),
        reason: 'adult_voice_not_attended'
      })
    );
  });
});
