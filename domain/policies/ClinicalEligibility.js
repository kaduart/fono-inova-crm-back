// domain/policies/ClinicalEligibility.js
// Política de Elegibilidade Clínica - Domínio Puro (Healthcare Business Rules)
// Responsabilidade: Validar se o atendimento pode ser realizado

import Logger from '../../services/utils/Logger.js';

const logger = new Logger('ClinicalEligibility');

/**
 * Catálogo de Mensagens Humanizadas por Tipo de Bloqueio
 */
const MESSAGES = {
  psychology_adult_rejection: ({ age }) =>
    `Entendi que é pra psicologia! 🧠\n\n` +
    `Aqui na Fono Inova a gente atende **psicologia infantil** (até 16 anos). ` +
    `Como é pra ${age} anos, a gente recomenda **Neuropsicologia** (avaliação das funções cerebrais) ` +
    `ou te ajudamos a encontrar um psicólogo clínico pra adultos.\n\n` +
    `Quer saber mais sobre **Neuropsicologia**? 💚`,

  fisio_baby_gate: () =>
    `Pra fisioterapia em bebezinhos, a gente trabalha com **Osteopatia Pediátrica** (super delicada e especializada)! 👶\n\n` +
    `Vou precisar que nossa equipe avalie o caso primeiro. Posso pedir que entrem em contato ainda hoje?`,

  medical_specialty_rejection: ({ specialty }) => {
    if (specialty.includes('neurolog')) {
      return `Entendi que você tá buscando **neurologista** 🧠\n\n` +
        `Aqui na Fono Inova a gente trabalha com **Neuropsicologia** (avaliação das funções cerebrais como atenção, memória, raciocínio), ` +
        `mas pra acompanhamento neurológico médico, você vai precisar consultar um neurologista clínico.\n\n` +
        `✨ Posso te ajudar com **Neuropsicologia** ou outras terapias:\n` +
        `• 💬 Fonoaudiologia\n• 🧠 Psicologia Infantil\n• 🏃 Fisioterapia\n• 🤲 Terapia Ocupacional\n• 📚 Psicopedagogia\n• 🎵 Musicoterapia\n\nQual te interessa?`;
    }

    if (specialty.includes('pediatra')) {
      return `Entendi! Você tá buscando **pediatra** 👶\n\n` +
        `A gente é uma clínica de **terapias e reabilitação**, não atendemos com pediatras.\n\n` +
        `Mas temos **terapias infantis** como:\n` +
        `• 💬 Fonoaudiologia (fala, linguagem)\n• 🧠 Psicologia Infantil\n• 🤲 Terapia Ocupacional\n• 📚 Psicopedagogia\n\nAlguma te interessa?`;
    }

    return `Entendi! Você tá buscando **${specialty}** 🏥\n\n` +
      `Somos especializados em **terapias e reabilitação**. Não atendemos com médicos, mas temos:\n` +
      `• 💬 Fonoaudiologia\n• 🧠 Psicologia\n• 🏃 Fisioterapia\n• 🤲 Terapia Ocupacional\n• 📚 Psicopedagogia\n• 🧩 Neuropsicologia\n• 🎵 Musicoterapia\n\nAlguma te interessa?`;
  },

  circuit_breaker_open: () =>
    `Desculpa, estou com dificuldade técnica no momento 😔\n\n` +
    `Vou pedir pra nossa equipe te retornar rapidinho, tudo bem? 💚`,

  tea_priority: () =>
    `Entendi! TEA (Transtorno do Espectro Autista) tem **prioridade** aqui 💙\n\n` +
    `Vou acelerar teu atendimento. Me passa mais alguns dados rapidinho?`
};

/**
 * Estados do Circuit Breaker
 */
const CircuitState = {
  CLOSED: 'closed',    // Normal (validações ativas)
  OPEN: 'open',        // Falhou muito (bypass validações, fail-safe)
  HALF_OPEN: 'half_open' // Testando recuperação
};

/**
 * Política de Elegibilidade Clínica
 * Implementa Circuit Breaker para fail-closed em healthcare
 */
export class ClinicalEligibility {
  constructor() {
    this.circuitState = CircuitState.CLOSED;
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.FAILURE_THRESHOLD = 3;
    this.TIMEOUT_MS = 60000; // 1 minuto
  }

  /**
   * Valida elegibilidade clínica com Circuit Breaker
   * @param {Object} params
   * @param {string} params.therapy - Terapia solicitada
   * @param {number} params.age - Idade do paciente
   * @param {string} params.text - Texto da mensagem (para detectar especialidades médicas)
   * @param {Object} params.clinicalHistory - Histórico de bloqueios anteriores
   * @returns {Object} { blocked, reason, message, alternative, context }
   */
  async validate({ therapy, age, text = '', clinicalHistory = {} }) {
    try {
      // Circuit Breaker OPEN → Fail-closed (bloqueia por segurança)
      if (this.circuitState === CircuitState.OPEN) {
        if (this.shouldAttemptReset()) {
          this.circuitState = CircuitState.HALF_OPEN;
          logger.info('CIRCUIT_HALF_OPEN', { reason: 'attempting_recovery' });
        } else {
          logger.warn('CIRCUIT_OPEN', { reason: 'validation_unavailable' });
          return {
            blocked: true,
            reason: 'CIRCUIT_BREAKER_OPEN',
            message: MESSAGES.circuit_breaker_open(),
            escalate: true // Sinaliza para escalar para humano
          };
        }
      }

      // Executa validações (pode lançar erro)
      const result = this._executeValidations({ therapy, age, text, clinicalHistory });

      // Sucesso → Reset circuit se estava em HALF_OPEN
      if (this.circuitState === CircuitState.HALF_OPEN) {
        this.closeCircuit();
      }

      return result;

    } catch (error) {
      logger.error('CLINICAL_VALIDATION_ERROR', { error: error.message, stack: error.stack });
      this.recordFailure();

      // Em caso de erro, fail-closed (bloqueia por segurança em healthcare)
      return {
        blocked: true,
        reason: 'VALIDATION_ERROR',
        message: MESSAGES.circuit_breaker_open(),
        escalate: true,
        error: error.message
      };
    }
  }

  /**
   * Executa validações clínicas (lógica pura de negócio)
   */
  _executeValidations({ therapy, age, text, clinicalHistory }) {
    const normalizedText = (text || '').toLowerCase();

    // PRIORIDADE 1: Contexto Clínico Acumulativo
    // Se bloqueio anterior sugeriu alternativa, herdar contexto
    if (clinicalHistory.lastBlockReason === 'PSYCHOLOGY_AGE_LIMIT' &&
        clinicalHistory.suggestedAlternative === 'neuropsicologia' &&
        normalizedText.match(/\b(sim|ok|tá bom|quero|vou querer|aceito)\b/)) {

      logger.info('CLINICAL_CONTEXT_INHERITED', {
        previousBlock: 'psychology_adult',
        acceptedAlternative: 'neuropsicologia'
      });

      return {
        blocked: false,
        context: {
          inheritedFrom: 'psychology_adult_rejection',
          therapy: 'neuropsicologia',
          reason: 'accepted_alternative'
        }
      };
    }

    // REGRA DURA 1: Especialidades Médicas (fora de escopo)
    const medicalSpecialty = this._detectMedicalSpecialty(normalizedText);
    if (medicalSpecialty) {
      return {
        blocked: true,
        reason: 'OUT_OF_SCOPE_MEDICAL',
        specialty: medicalSpecialty,
        message: MESSAGES.medical_specialty_rejection({ specialty: medicalSpecialty }),
        context: {
          suggestedAlternative: this._mapMedicalToTherapy(medicalSpecialty),
          redirectType: 'external_referral'
        }
      };
    }

    // REGRA DURA 2: Psicologia (apenas infantil, até 16 anos)
    if (therapy === 'psicologia' && age && age > 16) {
      return {
        blocked: true,
        reason: 'PSYCHOLOGY_AGE_LIMIT',
        message: MESSAGES.psychology_adult_rejection({ age }),
        alternative: 'neuropsicologia',
        context: {
          suggestedAlternative: 'neuropsicologia',
          pendingValidation: true,
          lastBlockReason: 'PSYCHOLOGY_AGE_LIMIT'
        }
      };
    }

    // REGRA DURA 3: Gate Osteopata (bebês ≤2 anos)
    if (therapy === 'fisioterapia' && age && age <= 2) {
      return {
        blocked: true,
        reason: 'OSTEOPATHY_GATE_REQUIRED',
        message: MESSAGES.fisio_baby_gate(),
        nextStep: 'osteopathy_assessment',
        escalate: true,
        context: {
          requiresHumanAssessment: true,
          specialty: 'osteopatia_pediatrica'
        }
      };
    }

    // REGRA SOFT 4: TEA (Prioridade, não bloqueia)
    if (this._detectsTEA(normalizedText)) {
      logger.info('TEA_PRIORITY_DETECTED', { therapy, age });
      return {
        blocked: false,
        priority: 'HIGH',
        message: MESSAGES.tea_priority(),
        context: {
          clinicalPriority: 'TEA',
          urgencyLevel: 'high'
        }
      };
    }

    // Passou todas as validações
    return { blocked: false };
  }

  /**
   * Detecta especialidades médicas na mensagem
   */
  _detectMedicalSpecialty(text) {
    const MEDICAL_SPECIALTIES = [
      // ✅ ATUALIZADO Abr/2026: Removido 'neuropediatra' - agora temos na clínica!
      { terms: ['neurologista', 'neurologia', 'neurologo'], type: 'neurologista' },
      { terms: ['pediatra', 'pediatria'], type: 'pediatra' },
      { terms: ['cardiologista', 'cardiologia', 'cardio'], type: 'cardiologista' },
      { terms: ['ortopedista', 'ortopedia'], type: 'ortopedista' },
      { terms: ['dermatologista', 'dermatologia'], type: 'dermatologista' },
      { terms: ['oftalmologista', 'oftalmologia', 'oftalmo'], type: 'oftalmologista' }
      // NOTA: neuropediatra foi removido da lista pois agora é um serviço disponível na clínica
    ];

    for (const specialty of MEDICAL_SPECIALTIES) {
      if (specialty.terms.some(term => text.includes(term))) {
        return specialty.type;
      }
    }

    return null;
  }

  /**
   * Detecta menção a TEA (Transtorno do Espectro Autista)
   */
  _detectsTEA(text) {
    return /\b(tea|autis|espectro\s+autista|asperger)\b/i.test(text);
  }

  /**
   * Mapeia especialidade médica para terapia disponível
   */
  _mapMedicalToTherapy(medicalSpecialty) {
    const mapping = {
      neurologista: 'neuropsicologia',
      pediatra: 'fonoaudiologia',
      cardiologista: null,
      ortopedista: 'fisioterapia',
      dermatologista: null,
      oftalmologista: null
    };

    return mapping[medicalSpecialty] || null;
  }

  // ===========================
  // Circuit Breaker Logic
  // ===========================

  recordFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.failureCount >= this.FAILURE_THRESHOLD) {
      this.openCircuit();
    }
  }

  openCircuit() {
    this.circuitState = CircuitState.OPEN;
    logger.error('CIRCUIT_OPENED', {
      failureCount: this.failureCount,
      threshold: this.FAILURE_THRESHOLD
    });
  }

  closeCircuit() {
    this.circuitState = CircuitState.CLOSED;
    this.failureCount = 0;
    logger.info('CIRCUIT_CLOSED', { reason: 'recovery_successful' });
  }

  shouldAttemptReset() {
    if (!this.lastFailureTime) return false;
    return Date.now() - this.lastFailureTime > this.TIMEOUT_MS;
  }

  /**
   * Método público para verificar estado do circuit breaker
   */
  getCircuitState() {
    return {
      state: this.circuitState,
      failureCount: this.failureCount,
      lastFailure: this.lastFailureTime
    };
  }
}

// Singleton instance (compartilhada entre requisições para manter estado do circuit)
export const clinicalEligibility = new ClinicalEligibility();
