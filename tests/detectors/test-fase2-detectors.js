/**
 * 🧪 TESTES UNITÁRIOS - FASE 2 DETECTORS
 *
 * Testa PriceDetector e SchedulingDetector com cenários reais extraídos de 75k linhas.
 *
 * 📊 COBERTURA:
 * - PriceDetector: insistence, objection, comparison, negotiation, acceptance
 * - SchedulingDetector: new, reschedule, urgency, cancellation, period preferences
 * - DetectorAdapter integration
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import PriceDetector from '../../detectors/PriceDetector.js';
import SchedulingDetector from '../../detectors/SchedulingDetector.js';
import { detectWithContext } from '../../detectors/DetectorAdapter.js';

describe('💰 PriceDetector - Unit Tests', () => {

  describe('Detecção de Insistência', () => {
    it('deve detectar insistência direta: "só o preço"', () => {
      const result = PriceDetector.detect('só o preço', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.priceType, 'insistence');
      assert.strictEqual(result.isInsistent, true);
      assert.ok(result.confidence > 0.7);
    });

    it('deve detectar insistência: "me passa o valor"', () => {
      const result = PriceDetector.detect('me passa o valor', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.priceType, 'insistence');
      assert.strictEqual(result.isInsistent, true);
    });

    it('deve detectar insistência: "quanto custa?"', () => {
      const result = PriceDetector.detect('quanto custa?', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.priceType, 'insistence');
      assert.strictEqual(result.isInsistent, true);
    });

    it('deve detectar insistência com contexto (Amanda já mencionou preço)', () => {
      const result = PriceDetector.detect('qual o valor?', {
        priceAlreadyMentioned: true
      });

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.priceType, 'insistence');
      assert.strictEqual(result.alreadyMentioned, true);
      assert.ok(result.confidence > 0.8); // Maior confiança com contexto
    });
  });

  describe('Detecção de Objeção', () => {
    it('deve detectar objeção: "o preço tá muito caro"', () => {
      const result = PriceDetector.detect('o preço tá muito caro', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.priceType, 'objection');
      assert.strictEqual(result.hasObjection, true);
      assert.strictEqual(result.requiresSpecialHandling, true);
    });

    it('deve detectar objeção: "esse valor tá puxado"', () => {
      const result = PriceDetector.detect('esse valor tá puxado', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.priceType, 'objection');
      assert.strictEqual(result.hasObjection, true);
    });

    it('deve detectar objeção: "não tenho condição de pagar esse preço"', () => {
      const result = PriceDetector.detect('não tenho condição de pagar esse preço', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.priceType, 'objection');
    });

    it('deve detectar objeção: "o valor ficou pesado pro bolso"', () => {
      const result = PriceDetector.detect('o valor ficou pesado pro bolso', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.priceType, 'objection');
      assert.ok(result.confidence > 0.8); // Objeção tem confiança alta
    });
  });

  describe('Detecção de Comparação', () => {
    it('deve detectar comparação: "achei outra clínica com preço mais barato"', () => {
      const result = PriceDetector.detect('achei outra clínica com preço mais barato', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.priceType, 'comparison');
      assert.strictEqual(result.hasObjection, true);
      assert.strictEqual(result.requiresSpecialHandling, true);
    });

    it('deve detectar comparação: "encontrei valor mais em conta"', () => {
      const result = PriceDetector.detect('encontrei valor mais em conta', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.priceType, 'comparison');
    });

    it('deve detectar comparação: "vi preço mais acessível"', () => {
      const result = PriceDetector.detect('vi um lugar com preço mais acessível', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.priceType, 'comparison');
    });
  });

  describe('Detecção de Negociação', () => {
    it('deve detectar negociação: "tem desconto no preço"', () => {
      const result = PriceDetector.detect('tem desconto no preço?', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.priceType, 'negotiation');
      assert.strictEqual(result.wantsNegotiation, true);
    });

    it('deve detectar negociação: "posso parcelar o valor"', () => {
      const result = PriceDetector.detect('posso parcelar o valor?', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.priceType, 'negotiation');
      assert.strictEqual(result.wantsNegotiation, true);
    });

    it('deve detectar negociação: "quanto fica parcelado"', () => {
      const result = PriceDetector.detect('qual o valor parcelado?', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.priceType, 'negotiation');
    });

    it('deve detectar negociação: "em quantas vezes posso pagar"', () => {
      const result = PriceDetector.detect('em quantas vezes posso pagar o valor?', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.priceType, 'negotiation');
    });
  });

  describe('Detecção de Aceitação', () => {
    it('deve detectar aceitação: "ok com o valor"', () => {
      const result = PriceDetector.detect('ok com o valor', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.priceType, 'acceptance');
      assert.strictEqual(result.hasAccepted, true);
    });

    it('deve detectar aceitação: "tudo bem o preço"', () => {
      const result = PriceDetector.detect('tudo bem o preço', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.priceType, 'acceptance');
    });

    it('deve detectar aceitação: "vou pagar esse valor"', () => {
      const result = PriceDetector.detect('vou pagar esse valor', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.priceType, 'acceptance');
    });

    it('deve detectar aceitação: "ok fechado, qual o preço"', () => {
      const result = PriceDetector.detect('ok, fechado o preço então', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.priceType, 'acceptance');
    });
  });

  describe('Casos Negativos', () => {
    it('não deve detectar sem menção a preço', () => {
      const result = PriceDetector.detect('quero agendar consulta', {});
      assert.strictEqual(result, null);
    });

    it('não deve detectar em mensagem vazia', () => {
      const result = PriceDetector.detect('', {});
      assert.strictEqual(result, null);
    });

    it('não deve detectar em null', () => {
      const result = PriceDetector.detect(null, {});
      assert.strictEqual(result, null);
    });
  });

  describe('Metadados', () => {
    it('deve incluir metadados corretos', () => {
      const result = PriceDetector.detect('quanto custa?', {});

      assert.ok(result.metadata);
      assert.strictEqual(result.metadata.detector, 'PriceDetector');
      assert.strictEqual(result.metadata.version, '1.0.0');
      assert.ok(result.metadata.originalText);
      assert.ok(result.metadata.detectedAt);
    });
  });
});

describe('📅 SchedulingDetector - Unit Tests', () => {

  describe('Detecção de Novo Agendamento', () => {
    it('deve detectar novo agendamento: "quero agendar"', () => {
      const result = SchedulingDetector.detect('quero agendar', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.schedulingType, 'new');
      assert.strictEqual(result.isNew, true);
      assert.ok(result.confidence > 0.7);
    });

    it('deve detectar novo agendamento: "gostaria de marcar uma consulta"', () => {
      const result = SchedulingDetector.detect('gostaria de marcar uma consulta', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.schedulingType, 'new');
      assert.strictEqual(result.isNew, true);
    });

    it('deve detectar novo agendamento: "tem vaga?"', () => {
      const result = SchedulingDetector.detect('tem vaga?', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.schedulingType, 'new');
    });

    it('deve detectar novo agendamento: "conseguir um horário"', () => {
      const result = SchedulingDetector.detect('preciso conseguir um horário', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.schedulingType, 'new');
    });
  });

  describe('Detecção de Remarcação', () => {
    it('deve detectar remarcação: "remarcar"', () => {
      const result = SchedulingDetector.detect('quero remarcar', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.schedulingType, 'reschedule');
      assert.strictEqual(result.isReschedule, true);
    });

    it('deve detectar remarcação: "mudar o horário"', () => {
      const result = SchedulingDetector.detect('posso mudar o horário?', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.schedulingType, 'reschedule');
    });

    it('deve detectar remarcação: "trocar a data da consulta"', () => {
      const result = SchedulingDetector.detect('gostaria de trocar a data da consulta', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.schedulingType, 'reschedule');
    });

    it('deve inferir remarcação pelo contexto (já tem agendamento)', () => {
      const result = SchedulingDetector.detect('quero um horário diferente', {
        hasScheduling: true
      });

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.schedulingType, 'reschedule');
      assert.strictEqual(result.alreadyHasScheduling, true);
    });
  });

  describe('Detecção de Urgência', () => {
    it('deve detectar urgência: "urgente"', () => {
      const result = SchedulingDetector.detect('preciso agendar urgente', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.hasUrgency, true);
      assert.strictEqual(result.requiresUrgentHandling, true);
      assert.ok(result.confidence > 0.8); // Urgência aumenta confiança
    });

    it('deve detectar urgência: "hoje"', () => {
      const result = SchedulingDetector.detect('tem vaga hoje?', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.hasUrgency, true);
    });

    it('deve detectar urgência: "logo"', () => {
      const result = SchedulingDetector.detect('preciso agendar logo', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.hasUrgency, true);
    });

    it('deve detectar urgência: "quanto antes"', () => {
      const result = SchedulingDetector.detect('marcar o mais rápido possível', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.hasUrgency, true);
    });

    it('deve detectar urgência: "essa semana"', () => {
      const result = SchedulingDetector.detect('tem horário essa semana?', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.hasUrgency, true);
    });
  });

  describe('Detecção de Cancelamento', () => {
    it('deve detectar cancelamento: "cancelar"', () => {
      const result = SchedulingDetector.detect('preciso cancelar', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.schedulingType, 'cancellation');
      assert.strictEqual(result.isCancellation, true);
    });

    it('deve detectar cancelamento: "não vou poder ir na consulta"', () => {
      const result = SchedulingDetector.detect('não vou poder ir na consulta', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.schedulingType, 'cancellation');
    });

    it('deve detectar cancelamento: "surgiu um imprevisto, preciso desmarcar"', () => {
      const result = SchedulingDetector.detect('surgiu um imprevisto, preciso desmarcar', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.schedulingType, 'cancellation');
    });

    it('deve detectar cancelamento: "desmarcar"', () => {
      const result = SchedulingDetector.detect('vou desmarcar', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.schedulingType, 'cancellation');
    });
  });

  describe('Detecção de Período Preferido - Manhã', () => {
    it('deve detectar preferência manhã: "manhã"', () => {
      const result = SchedulingDetector.detect('tem vaga de manhã?', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.preferredPeriod, 'morning');
      assert.ok(result.confidence > 0.7); // Período específico aumenta confiança
    });

    it('deve detectar preferência manhã: "cedo"', () => {
      const result = SchedulingDetector.detect('quero agendar cedo', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.preferredPeriod, 'morning');
    });

    it('deve detectar preferência manhã: "antes do meio-dia"', () => {
      const result = SchedulingDetector.detect('tem horário antes do meio-dia', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.preferredPeriod, 'morning');
    });

    it('deve detectar preferência manhã: "9h"', () => {
      const result = SchedulingDetector.detect('tem horário às 9h?', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.preferredPeriod, 'morning');
    });
  });

  describe('Detecção de Período Preferido - Tarde', () => {
    it('deve detectar preferência tarde: "tarde"', () => {
      const result = SchedulingDetector.detect('tem vaga à tarde?', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.preferredPeriod, 'afternoon');
    });

    it('deve detectar preferência tarde: "depois do almoço"', () => {
      const result = SchedulingDetector.detect('quero marcar depois do almoço', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.preferredPeriod, 'afternoon');
    });

    it('deve detectar preferência tarde: "14h"', () => {
      const result = SchedulingDetector.detect('tem horário às 14h?', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.preferredPeriod, 'afternoon');
    });
  });

  describe('Detecção de Flexibilidade', () => {
    it('deve detectar flexibilidade: "qualquer horário"', () => {
      const result = SchedulingDetector.detect('qualquer horário serve', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.preferredPeriod, 'flexible');
      assert.strictEqual(result.isFlexible, true);
    });

    it('deve detectar flexibilidade: "tanto faz"', () => {
      const result = SchedulingDetector.detect('tanto faz o horário', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.preferredPeriod, 'flexible');
    });

    it('deve detectar flexibilidade ao mencionar manhã e tarde', () => {
      const result = SchedulingDetector.detect('quero agendar, pode ser manhã ou tarde', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.preferredPeriod, 'flexible');
    });
  });

  describe('Casos Negativos', () => {
    it('não deve detectar sem menção a agendamento', () => {
      const result = SchedulingDetector.detect('quanto custa?', {});
      assert.strictEqual(result, null);
    });

    it('não deve detectar em mensagem vazia', () => {
      const result = SchedulingDetector.detect('', {});
      assert.strictEqual(result, null);
    });

    it('não deve detectar em null', () => {
      const result = SchedulingDetector.detect(null, {});
      assert.strictEqual(result, null);
    });
  });

  describe('Cenários Compostos', () => {
    it('deve detectar urgência + período + tipo', () => {
      const result = SchedulingDetector.detect('preciso remarcar urgente, de manhã', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.schedulingType, 'reschedule');
      assert.strictEqual(result.hasUrgency, true);
      assert.strictEqual(result.preferredPeriod, 'morning');
      assert.ok(result.confidence > 0.9); // Múltiplos sinais = alta confiança
    });

    it('deve detectar novo + urgência', () => {
      const result = SchedulingDetector.detect('quero agendar hoje', {});

      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.schedulingType, 'new');
      assert.strictEqual(result.hasUrgency, true);
    });
  });

  describe('Metadados', () => {
    it('deve incluir metadados corretos', () => {
      const result = SchedulingDetector.detect('quero agendar', {});

      assert.ok(result.metadata);
      assert.strictEqual(result.metadata.detector, 'SchedulingDetector');
      assert.strictEqual(result.metadata.version, '1.0.0');
      assert.ok(result.metadata.originalText);
      assert.ok(result.metadata.detectedAt);
    });
  });
});

describe('🔌 DetectorAdapter - Integration Tests FASE 2', () => {

  describe('Integração PriceDetector', () => {
    it('deve enriquecer flags com detecção de insistência', () => {
      const result = detectWithContext('só o preço', {}, {});

      assert.strictEqual(result.asksPrice, true);
      assert.strictEqual(result.insistsPrice, true);
      assert.ok(result._price);
      assert.strictEqual(result._price.priceType, 'insistence');
      assert.strictEqual(result._price.isInsistent, true);
    });

    it('deve enriquecer flags com detecção de objeção', () => {
      const result = detectWithContext('o preço tá muito caro', {}, {});

      assert.strictEqual(result.asksPrice, true);
      assert.strictEqual(result.mentionsPriceObjection, true);
      assert.ok(result._price);
      assert.strictEqual(result._price.priceType, 'objection');
      assert.strictEqual(result._price.hasObjection, true);
    });

    it('deve enriquecer flags com detecção de negociação', () => {
      const result = detectWithContext('tem desconto no preço?', {}, {});

      assert.strictEqual(result.asksPrice, true);
      assert.strictEqual(result.wantsNegotiation, true);
      assert.ok(result._price);
      assert.strictEqual(result._price.priceType, 'negotiation');
    });

    it('deve enriquecer flags com detecção de aceitação', () => {
      const result = detectWithContext('ok com o valor', {}, {});

      assert.strictEqual(result.asksPrice, true);
      assert.strictEqual(result.acceptsPrice, true);
      assert.ok(result._price);
      assert.strictEqual(result._price.priceType, 'acceptance');
    });
  });

  describe('Integração SchedulingDetector', () => {
    it('deve enriquecer flags com detecção de remarcação', () => {
      const result = detectWithContext('quero remarcar', {}, {});

      assert.strictEqual(result.wantsSchedule, true);
      assert.strictEqual(result.wantsReschedule, true);
      assert.ok(result._scheduling);
      assert.strictEqual(result._scheduling.schedulingType, 'reschedule');
    });

    it('deve enriquecer flags com detecção de cancelamento', () => {
      const result = detectWithContext('preciso cancelar', {}, {});

      assert.strictEqual(result.wantsSchedule, true);
      assert.strictEqual(result.wantsCancellation, true);
      assert.ok(result._scheduling);
      assert.strictEqual(result._scheduling.schedulingType, 'cancellation');
    });

    it('deve enriquecer flags com detecção de urgência', () => {
      const result = detectWithContext('preciso agendar urgente', {}, {});

      assert.strictEqual(result.wantsSchedule, true);
      assert.strictEqual(result.mentionsUrgency, true);
      assert.ok(result._scheduling);
      assert.strictEqual(result._scheduling.hasUrgency, true);
    });

    it('deve enriquecer flags com preferência de manhã', () => {
      const result = detectWithContext('tem vaga de manhã?', {}, {});

      assert.strictEqual(result.wantsSchedule, true);
      assert.strictEqual(result.prefersMorning, true);
      assert.ok(result._scheduling);
      assert.strictEqual(result._scheduling.preferredPeriod, 'morning');
    });

    it('deve enriquecer flags com preferência de tarde', () => {
      const result = detectWithContext('tem vaga à tarde?', {}, {});

      assert.strictEqual(result.wantsSchedule, true);
      assert.strictEqual(result.prefersAfternoon, true);
      assert.ok(result._scheduling);
      assert.strictEqual(result._scheduling.preferredPeriod, 'afternoon');
    });
  });

  describe('Metadados do Adapter', () => {
    it('deve incluir metadados FASE 2 quando PriceDetector ativa', () => {
      const result = detectWithContext('quanto custa?', {}, {});

      assert.ok(result._meta);
      assert.strictEqual(result._meta.hasContextualDetection, true);
      assert.strictEqual(result._meta.detectors.price, 'active');
    });

    it('deve incluir metadados FASE 2 quando SchedulingDetector ativa', () => {
      const result = detectWithContext('quero agendar', {}, {});

      assert.ok(result._meta);
      assert.strictEqual(result._meta.hasContextualDetection, true);
      assert.strictEqual(result._meta.detectors.scheduling, 'active');
    });

    it('deve incluir metadados de todos os detectores', () => {
      // Testa que todos os detectores FASE 1 + FASE 2 estão registrados
      const result = detectWithContext('quero agendar', {}, {});

      assert.ok(result._meta);
      assert.ok(result._meta.detectors);

      // Verifica que todos os detectores estão presentes (FASE 1 + FASE 2)
      assert.ok('confirmation' in result._meta.detectors);
      assert.ok('insurance' in result._meta.detectors);
      assert.ok('price' in result._meta.detectors);
      assert.ok('scheduling' in result._meta.detectors);

      // Pelo menos scheduling deve estar ativo
      assert.strictEqual(result._meta.detectors.scheduling, 'active');
    });
  });

  describe('Backward Compatibility', () => {
    it('deve manter flags legacy funcionando', () => {
      const result = detectWithContext('quanto custa?', {}, {});

      // Flag legacy deve existir
      assert.strictEqual(result.asksPrice, true);

      // Dados novos devem estar em _price
      assert.ok(result._price);
      assert.ok(result._price.priceType);
    });

    it('deve funcionar sem quebrar quando detector não ativa', () => {
      const result = detectWithContext('olá', {}, {});

      // Não deve quebrar
      assert.ok(result);
      assert.ok(result._meta);

      // Detectores devem estar inativos
      assert.strictEqual(result._meta.detectors.price, 'inactive');
      assert.strictEqual(result._meta.detectors.scheduling, 'inactive');
    });
  });
});

describe('📊 Stats e Feedback - FASE 2', () => {

  it('PriceDetector deve retornar stats', () => {
    const stats = PriceDetector.getStats();

    assert.ok(stats);
    assert.ok(stats.dataSource);
    assert.ok(stats.expectedImpact);
    assert.ok(stats.totalPatterns);
    assert.ok(stats.totalPatterns.insistence > 0);
    assert.ok(stats.totalPatterns.objection > 0);
    assert.ok(stats.totalPatterns.negotiation > 0);
  });

  it('SchedulingDetector deve retornar stats', () => {
    const stats = SchedulingDetector.getStats();

    assert.ok(stats);
    assert.ok(stats.dataSource);
    assert.ok(stats.expectedImpact);
    assert.ok(stats.totalPatterns);
    assert.ok(stats.totalPatterns.newBooking > 0);
    assert.ok(stats.totalPatterns.reschedule > 0);
    assert.ok(stats.totalPatterns.urgency > 0);
  });

  it('PriceDetector deve aceitar feedback', () => {
    const text = 'quanto custa?';

    // Não deve quebrar
    assert.doesNotThrow(() => {
      PriceDetector.addFeedback(text, true, 'insistence');
    });
  });

  it('SchedulingDetector deve aceitar feedback', () => {
    const text = 'quero agendar';

    // Não deve quebrar
    assert.doesNotThrow(() => {
      SchedulingDetector.addFeedback(text, true, 'new');
    });
  });
});

console.log('✅ Todos os testes FASE 2 carregados');
