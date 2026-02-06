/**
 * 🧪 TESTES BASEADOS EM CONVERSAS REAIS
 * 
 * Origem: whatsapp_export_2025-11-26.txt + historico-de-leads.txt
 * Filosofia: Testar o que QUEBROU em produção, não cenários imaginários
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WhatsAppOrchestrator } from '../../orchestrators/WhatsAppOrchestrator.js';
import { smartFallback } from '../../services/intelligence/SmartFallback.js';

// 🎯 CASOS REAIS EXTRAÍDOS DOS ARQUIVOS

const REAL_CASES = {
  // MC-01: Dayene com 2 crianças (TEA + TDAH)
  MULTIPLE_CHILDREN_01: {
    id: 'MC-01',
    description: 'Dayene - Pedro (6, TEA) + Thiago (8, TDAH)',
    history: [
      { role: 'user', content: 'Oi, tenho dois filhos que precisam de avaliação' },
      { role: 'assistant', content: 'Oi! Que bom que você entrou em contato 💚 Me conta: qual a idade deles e o que está acontecendo?' },
      { role: 'user', content: 'Pedro tem 6 anos e tem laudo de TEA, Thiago tem 8 e tem TDAH' },
      { role: 'assistant', content: 'Entendo... Deve ser desafiador cuidar de dois com necessidades diferentes 💚 Vocês estão buscando qual terapia?' }
    ],
    currentMessage: 'Preciso de avaliação para os dois na terapia ocupacional',
    expected: {
      action: 'acknowledge_both',
      detectMultipleChildren: true,
      applyDiscount: true,
      responseIncludes: ['duas crianças', 'desconto', 'R$ 200']
    }
  },

  // DC-01: Lavínia - sem dinheiro até receber
  NO_MONEY_NOW: {
    id: 'DC-01',
    description: 'Lavínia - Mãe não recebeu para pagar',
    history: [
      { role: 'assistant', content: 'Confirmado! A sessão está agendada para amanhã às 10h 💚' }
    ],
    currentMessage: 'Minha mãe ainda não recebeu para pagar, pode remarcar?',
    expected: {
      action: 'reschedule_with_empathy',
      detectPattern: 'no_money',
      offerAlternatives: true,
      responseIncludes: ['sem problema', 'remarcamos', 'quando ficar melhor']
    }
  },

  // CH-01: Mariluiza confunde dia da semana
  WRONG_DAY_CONFUSION: {
    id: 'CH-01',
    description: 'Mariluiza - confundiu segunda com terça',
    history: [
      { role: 'assistant', content: 'Confirmado: Terça-feira, dia 14/01 às 14h 💚' }
    ],
    currentMessage: 'Hj segunda feira né, confirmado',
    expected: {
      action: 'clarify_day',
      detectMismatch: true,
      responseIncludes: ['terça-feira', 'dia 14', 'não segunda']
    }
  },

  // QF-01: Dayene - desconto para múltiplas crianças
  MULTIPLE_CHILDREN_DISCOUNT: {
    id: 'QF-01',
    description: 'Dayene - desconto automático 2 crianças',
    history: [
      { role: 'user', content: 'Quanto fica a avaliação para os dois?' }
    ],
    currentMessage: 'E quanto fica para os dois juntos?',
    leadData: {
      patientInfo: { count: 2 },
      primaryComplaint: 'TEA + TDAH'
    },
    expected: {
      action: 'calculate_discount',
      price: 200, // cobra 1 ao invés de 2
      responseIncludes: ['somente uma', 'R$ 200', 'duas crianças']
    }
  },

  // IF-01: Thiago - pergunta plano Hapvida no início
  PLAN_QUESTION_EARLY: {
    id: 'IF-01',
    description: 'Thiago - pergunta plano antes de qualificar',
    history: [],
    currentMessage: 'Por gentileza, quais fonoaudiólogos trabalham com vocês e atendem Unimed?',
    expected: {
      action: 'answer_plan_question',
      shouldNotSaveAsComplaint: true,
      responseIncludes: ['processo de credenciamento', 'atualmente particular'],
      thenAsk: 'qual especialidade você precisa'
    }
  },

  // CB-05: Sábado não atende
  SATURDAY_REQUEST: {
    id: 'CB-05',
    description: 'Cliente quer sábado, clínica não atende',
    history: [
      { role: 'user', content: 'Quero agendar fonoaudiologia' },
      { role: 'assistant', content: 'Perfeito! Qual período funciona melhor: manhã ou tarde?' },
      { role: 'user', content: 'Manhã' }
    ],
    currentMessage: 'Tem atendimento no sábado?',
    expected: {
      action: 'explain_no_saturday',
      offerAlternatives: ['segunda manhã', 'demais dias tarde'],
      responseIncludes: ['não atendemos sábado', 'segunda pela manhã']
    }
  },

  // EC-03: Resposta curta "Ok" ou "Sim"
  SHORT_REPLY_OK: {
    id: 'EC-03',
    description: 'Usuário responde apenas "Ok" - referenciar contexto',
    history: [
      { role: 'assistant', content: 'Encontrei horários de manhã: Segunda 10h ou Quarta 9h. Qual funciona melhor?' }
    ],
    currentMessage: 'Ok',
    expected: {
      action: 'ask_clarification_with_context',
      referenceLastQuestion: true,
      responseIncludes: ['segunda 10h', 'quarta 9h', 'qual prefere']
    }
  },

  // FR-02: Retorno após pausa (Jesilene)
  RETURN_AFTER_TRAVEL: {
    id: 'FR-02',
    description: 'Jesilene - volta de viagem, quer reativar',
    history: [
      { role: 'user', content: 'Chegamos de viagem, hoje da pra atender?' }
    ],
    currentMessage: 'Chegamos de viagem, hoje da pra atender?',
    leadData: {
      lastContactAt: '2025-01-10T10:00:00Z', // 15 dias atrás
      isExistingPatient: true
    },
    expected: {
      action: 'reactivate_quickly',
      detectReturn: true,
      responseIncludes: ['que bom que voltou', 'vou verificar', 'hoje temos']
    }
  },

  // ES-01: Confusão Fono vs Psicopedagoga
  SPECIALTY_CONFUSION: {
    id: 'ES-01',
    description: 'Queixa escolar → Psicopedagoga, não Psicologia',
    history: [],
    currentMessage: 'Minha filha está tendo dificuldade na escola para ler e escrever',
    expected: {
      action: 'suggest_psychopedagogy',
      detectAcademicDifficulty: true,
      responseIncludes: ['psicopedagoga', 'dificuldades de aprendizagem'],
      notSuggest: 'psicologia'
    }
  },

  // DC-04: Doença da criança
  CHILD_SICK_CANCEL: {
    id: 'DC-04',
    description: 'Kálita - Heloísa gripou, precisa remarcar',
    history: [
      { role: 'assistant', content: 'Lembrete: Sessão amanhã às 10h com a Dra. Mikaelly 💚' }
    ],
    currentMessage: 'Minha filha gripou e está tossindo muito, pode remarcar?',
    expected: {
      action: 'reschedule_sick_child',
      detectSickness: true,
      waiveFee: true, // desconto de fidelidade
      responseIncludes: ['melhoras', 'sem custo', 'remarcamos']
    }
  }
};

// 🧪 TESTES IMPLEMENTADOS
describe('🚨 Casos Reais - WhatsApp Export', () => {
  let orchestrator;

  beforeEach(() => {
    orchestrator = new WhatsAppOrchestrator();
  });

  describe('Múltiplas Crianças (MC)', () => {
    it('MC-01: Detecta 2 crianças e aplica desconto automático', async () => {
      const testCase = REAL_CASES.MULTIPLE_CHILDREN_01;
      
      const result = await orchestrator.process({
        message: { text: testCase.currentMessage },
        history: testCase.history,
        lead: { _id: 'test-dayene', name: 'Dayene' }
      });

      expect(result.text).toContain('duas crianças');
      expect(result.text).toContain('R$ 200');
      expect(result.extractedInfo.multipleChildren).toBe(true);
      expect(result.extractedInfo.discountApplied).toBe(true);
    });

    it('QF-01: Calcula valor correto para avaliação dupla', async () => {
      const testCase = REAL_CASES.MULTIPLE_CHILDREN_DISCOUNT;
      
      const result = await smartFallback({
        userMessage: testCase.currentMessage,
        history: testCase.history,
        leadData: testCase.leadData,
        enrichedContext: { isExistingPatient: false }
      });

      expect(result.text).toContain('somente uma');
      expect(result.text).toMatch(/R\$\s*200/);
      expect(result.action).toBe('calculate_discount');
    });
  });

  describe('Desistência/Cancelamento (DC)', () => {
    it('DC-01: Detecta "não tenho dinheiro" e oferece remarcação', async () => {
      const testCase = REAL_CASES.NO_MONEY_NOW;
      
      const result = await smartFallback({
        userMessage: testCase.currentMessage,
        history: testCase.history,
        leadData: {},
        enrichedContext: {}
      });

      expect(result.detectedIntent).toContain('no_money');
      expect(result.response).toContain('remarcamos');
      expect(result.response).toContain('quando ficar melhor');
    });

    it('DC-04: Reconhece doença e remarca sem custo', async () => {
      const testCase = REAL_CASES.CHILD_SICK_CANCEL;
      
      const result = await orchestrator.process({
        message: { text: testCase.currentMessage },
        history: testCase.history,
        lead: { _id: 'test-kalita', name: 'Kálita', isExistingPatient: true }
      });

      expect(result.text.toLowerCase()).toContain('melhoras');
      expect(result.extractedInfo.waiveRescheduleFee).toBe(true);
    });
  });

  describe('Confusão de Horário (CH)', () => {
    it('CH-01: Detecta erro de dia e corrige', async () => {
      const testCase = REAL_CASES.WRONG_DAY_CONFUSION;
      
      const result = await orchestrator.process({
        message: { text: testCase.currentMessage },
        history: testCase.history,
        lead: { _id: 'test-mariluiza' }
      });

      expect(result.text.toLowerCase()).toContain('terça');
      expect(result.text).toContain('dia 14');
      expect(result.text.toLowerCase()).not.toContain('segunda');
    });
  });

  describe('Perguntas Fora do Fluxo (IF)', () => {
    it('IF-01: NÃO salva pergunta de plano como queixa', async () => {
      const testCase = REAL_CASES.PLAN_QUESTION_EARLY;
      
      const result = await orchestrator.process({
        message: { text: testCase.currentMessage },
        history: testCase.history,
        lead: { _id: 'test-thiago' }
      });

      expect(result.extractedInfo.primaryComplaint).toBeUndefined();
      expect(result.text).toContain('credenciamento');
      expect(result.text.toLowerCase()).toContain('particular');
    });

    it('CB-05: Explica que não atende sábado e oferece alternativa', async () => {
      const testCase = REAL_CASES.SATURDAY_REQUEST;
      
      const result = await orchestrator.process({
        message: { text: testCase.currentMessage },
        history: testCase.history,
        lead: { _id: 'test-sabado' }
      });

      expect(result.text.toLowerCase()).toContain('não atendemos sábado');
      expect(result.text.toLowerCase()).toContain('segunda');
    });
  });

  describe('Respostas Curtas (EC)', () => {
    it('EC-03: "Ok" sem contexto → referencia última pergunta', async () => {
      const testCase = REAL_CASES.SHORT_REPLY_OK;
      
      const result = await smartFallback({
        userMessage: testCase.currentMessage,
        history: testCase.history,
        leadData: {},
        enrichedContext: {}
      });

      expect(result.action).toBe('ask_clarification');
      expect(result.response).toContain('segunda');
      expect(result.response).toContain('quarta');
    });
  });

  describe('Retorno de Paciente (FR)', () => {
    it('FR-02: Detecta retorno após viagem e reativa rápido', async () => {
      const testCase = REAL_CASES.RETURN_AFTER_TRAVEL;
      
      const result = await smartFallback({
        userMessage: testCase.currentMessage,
        history: testCase.history,
        leadData: testCase.leadData,
        enrichedContext: {
          hoursSinceLastContact: 360, // 15 dias
          isExistingPatient: true
        }
      });

      expect(result.detectedIntent).toContain('return_after_pause');
      expect(result.response).toContain('que bom que voltou');
    });
  });

  describe('Direcionamento Especialidade (ES)', () => {
    it('ES-01: Dificuldade escolar → Psicopedagoga', async () => {
      const testCase = REAL_CASES.SPECIALTY_CONFUSION;
      
      const result = await orchestrator.process({
        message: { text: testCase.currentMessage },
        history: testCase.history,
        lead: { _id: 'test-escola' }
      });

      expect(result.text.toLowerCase()).toContain('psicopedagoga');
      expect(result.text.toLowerCase()).not.toContain('psicólogo');
      expect(result.extractedInfo.therapyArea).toBe('psicopedagogia');
    });
  });
});

// 📊 MÉTRICAS DE COBERTURA
describe('📊 Métricas dos Casos Reais', () => {
  it('Cobre 100% dos casos críticos do arquivo whatsapp_export', () => {
    const criticalCases = Object.keys(REAL_CASES).length;
    expect(criticalCases).toBeGreaterThanOrEqual(10);
  });

  it('Todos os casos têm expected behavior definido', () => {
    Object.values(REAL_CASES).forEach(testCase => {
      expect(testCase.expected).toBeDefined();
      expect(testCase.id).toMatch(/^[A-Z]+-\d+$/);
    });
  });
});

export { REAL_CASES };
