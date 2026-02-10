// perception/PerceptionService.js
// Serviço de Percepção - Unifica detecção de fatos (NLU Layer)
// Responsabilidade: Transformar texto bruto em fatos estruturados (sem decisões)

import { detectAllFlags } from '../utils/flagsDetector.js';
import { detectAllTherapies } from '../utils/therapyDetector.js';
import { extractEntities } from '../services/intelligence/EntityExtractor.js';
import Logger from '../services/utils/Logger.js';

const logger = new Logger('PerceptionService');

/**
 * Serviço de Percepção - Retorna APENAS FATOS, sem decisões de negócio
 *
 * Entrada: texto bruto + contexto histórico
 * Saída: objeto estruturado de fatos detectados
 *
 * NÃO decide o que fazer (isso é responsabilidade de Policies/Orchestrator)
 * Apenas observa e relata
 */
export class PerceptionService {
  /**
   * Analisa mensagem e retorna fatos detectados
   * @param {string} text - Texto da mensagem do usuário
   * @param {Object} lead - Lead do banco (para contexto histórico)
   * @param {Object} memory - Memória de contexto (da sessão)
   * @returns {Object} Fatos detectados (entities, flags, therapies, intent)
   */
  async analyze(text, lead = {}, memory = {}) {
    const startTime = Date.now();

    try {
      // 1. Extração de Entidades (idade, nome, período, etc.)
      const entities = extractEntities(text, memory);

      // 2. Detecção de Flags (objeções, urgência, TEA, etc.)
      const flags = detectAllFlags(text, lead, memory);

      // 3. Detecção de Terapias (fono, psico, fisio, etc.)
      const therapies = detectAllTherapies(text);

      // 4. Intenção Principal (heurística simples, não usa LLM)
      const intent = this._detectIntent(text, flags, entities);

      // 5. Metadados de Percepção
      const metadata = {
        textLength: text.length,
        hasEmojis: /[\u{1F600}-\u{1F64F}]/u.test(text),
        hasNumbers: /\d/.test(text),
        hasQuestionMark: text.includes('?'),
        isShortResponse: text.length < 30,
        confidence: this._calculateConfidence(entities, flags, therapies)
      };

      const facts = {
        // Entidades extraídas
        entities,

        // Flags semânticos
        flags,

        // Terapias detectadas
        therapies: {
          primary: therapies[0] || null,
          alternatives: therapies.slice(1),
          count: therapies.length
        },

        // Intenção detectada
        intent,

        // Metadados
        metadata,

        // Timestamp
        analyzedAt: new Date()
      };

      const duration = Date.now() - startTime;

      logger.debug('PERCEPTION_COMPLETE', {
        leadId: lead?._id,
        duration,
        entitiesFound: Object.keys(entities).filter(k => entities[k]).length,
        flagsActive: Object.keys(flags).filter(k => flags[k] === true).length,
        therapiesDetected: therapies.length,
        intent: intent.type,
        confidence: metadata.confidence
      });

      return facts;

    } catch (error) {
      logger.error('PERCEPTION_ERROR', {
        error: error.message,
        stack: error.stack,
        text: text.substring(0, 100)
      });

      // Em caso de erro, retorna fatos vazios (fail-safe)
      return {
        entities: {},
        flags: {},
        therapies: { primary: null, alternatives: [], count: 0 },
        intent: { type: 'unknown', confidence: 0 },
        metadata: { error: error.message },
        analyzedAt: new Date()
      };
    }
  }

  /**
   * Detecta intenção principal (heurística, não ML)
   * @private
   */
  _detectIntent(text, flags, entities) {
    const textLower = text.toLowerCase();

    // INTENÇÃO 1: Agendamento
    if (flags.wantsSchedule || flags.wantsSchedulingNow || flags.inSchedulingFlow) {
      return {
        type: 'schedule',
        confidence: 0.9,
        source: 'flags.wantsSchedule'
      };
    }

    // INTENÇÃO 2: Informação sobre Preço
    if (flags.asksPrice || flags.insistsPrice) {
      return {
        type: 'price_inquiry',
        confidence: 0.95,
        source: 'flags.asksPrice'
      };
    }

    // INTENÇÃO 3: Informação sobre Localização
    if (flags.asksAddress || flags.asksLocation) {
      return {
        type: 'location_inquiry',
        confidence: 0.9,
        source: 'flags.asksAddress'
      };
    }

    // INTENÇÃO 4: Informação sobre Planos
    if (flags.asksPlans) {
      return {
        type: 'insurance_inquiry',
        confidence: 0.9,
        source: 'flags.asksPlans'
      };
    }

    // INTENÇÃO 5: Objeção/Desistência
    if (flags.givingUp || flags.refusesOrDenies) {
      return {
        type: 'objection',
        confidence: 0.85,
        source: 'flags.givingUp'
      };
    }

    // INTENÇÃO 6: Confirmação
    if (flags.confirmsData && text.length < 30) {
      return {
        type: 'confirmation',
        confidence: 0.8,
        source: 'flags.confirmsData'
      };
    }

    // INTENÇÃO 7: Escolha de Opção (A, B, C)
    if (/\b[abc]\b/i.test(textLower) && text.length < 20) {
      return {
        type: 'option_selection',
        confidence: 0.75,
        source: 'pattern_match_abc'
      };
    }

    // INTENÇÃO 8: Fornecer Dados (nome, idade, período)
    if (entities.patientName || entities.age || entities.period) {
      return {
        type: 'provide_data',
        confidence: 0.7,
        source: 'entities_detected'
      };
    }

    // INTENÇÃO PADRÃO: Informação Geral
    return {
      type: 'information',
      confidence: 0.5,
      source: 'default'
    };
  }

  /**
   * Calcula confiança geral da percepção
   * @private
   */
  _calculateConfidence(entities, flags, therapies) {
    let confidence = 0;

    // Entidades claras aumentam confiança
    const entitiesCount = Object.keys(entities).filter(k => entities[k]).length;
    confidence += entitiesCount * 0.15;

    // Flags ativos aumentam confiança
    const flagsCount = Object.keys(flags).filter(k => flags[k] === true).length;
    confidence += flagsCount * 0.1;

    // Terapia detectada aumenta confiança
    if (therapies.length > 0) confidence += 0.2;

    // Normaliza entre 0-1
    return Math.min(confidence, 1.0);
  }

  /**
   * Método auxiliar: Verifica se percepção tem dados suficientes
   */
  hasMinimumData(facts) {
    return (
      facts.therapies.primary !== null ||
      Object.keys(facts.entities).filter(k => facts.entities[k]).length >= 2 ||
      Object.keys(facts.flags).filter(k => facts.flags[k] === true).length >= 3
    );
  }

  /**
   * Método auxiliar: Extrai resumo dos fatos (para logging)
   */
  summarize(facts) {
    return {
      therapy: facts.therapies.primary,
      intent: facts.intent.type,
      age: facts.entities.age,
      flags: Object.keys(facts.flags).filter(k => facts.flags[k] === true),
      confidence: facts.metadata.confidence
    };
  }
}

// Exporta instância singleton
export const perceptionService = new PerceptionService();
