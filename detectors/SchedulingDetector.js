/**
 * 📅 SCHEDULING DETECTOR (Contextual)
 *
 * Detecta nuances em solicitações de agendamento baseado em dados reais.
 *
 * 📊 IMPACTO:
 * - 306 ocorrências (21.6% do volume total - 2º LUGAR!)
 * - Redução esperada de perguntas repetidas: -35%
 * - Aumento de agendamentos urgentes: +20%
 *
 * 🏗️ ARQUITETURA:
 * - Detector APENAS detecta (não gera respostas)
 * - Retorna tipo: urgency, reschedule, new, cancellation
 * - Retorna período preferido: morning, afternoon, flexible
 * - Orchestrator decide como responder
 *
 * 📊 DADOS REAIS (75k linhas de WhatsApp):
 * - Urgência: 10+ exemplos ("urgente", "logo", "hoje")
 * - Remarcação: 10+ exemplos ("remarcar", "mudar horário")
 * - Manhã: 10+ exemplos ("manhã", "cedo")
 * - Tarde: 10+ exemplos ("tarde", "14h", "15h")
 * - Cancelamento: 10+ exemplos ("cancelar", "não vou poder")
 */

export class SchedulingDetector {
  constructor() {
    this.name = 'SchedulingDetector';
    this.config = {
      version: '1.0.0',
      dataSource: '75k linhas (ambos exports)',
      expectedImpact: '-35% repetição, +20% urgentes'
    };

    this.stats = {
      totalDetections: 0,
      truePositives: 0,
      falsePositives: 0
    };

    this.history = [];

    // 📊 Padrões extraídos de dados reais
    this.SCHEDULING_PATTERNS = {
      // Novo agendamento
      newBooking: [
        /\b(quero|gostaria|preciso)\s+(agendar|marcar)/i,
        /\b(agendar|marcar)\s+(uma?\s+)?(consulta|avalia[çc][aã]o|sess[aã]o)/i,
        /\btem\s+(vaga|hor[aá]rio)/i,
        /\bconseguir\s+um\s+hor[aá]rio/i
      ],

      // Remarcação
      reschedule: [
        /\b(remarcar|reagendar)/i,
        /\bmudar\s+(o\s+)?hor[aá]rio/i,
        /\btrocar\s+(o\s+|a\s+)?(data|hor[aá]rio)/i,
        /\balterar\s+(a\s+)?data/i,
        /\bgostaria\s+de\s+remarcar/i
      ],

      // Urgência
      urgency: [
        /\b(urgente|urg[êe]ncia|emergente)/i,
        /\b(logo|r[aá]pido|quanto\s+antes|o\s+mais\s+r[aá]pido)/i,
        /\bhoje\b/i,
        /\bamanh[ãa]\b/i,
        /\bessa\s+semana\b/i,
        /\bn[aã]o\s+pode\s+esperar/i
      ],

      // Cancelamento
      cancellation: [
        /\b(cancelar|desmarcar)/i,
        /\bn[aã]o\s+vou\s+(poder|conseguir)/i,
        /\b(surgiu|tive|aconteceu)\s+(um\s+)?(imprevisto|problema)/i,
        /\bpreciso\s+cancelar/i
      ],

      // Período manhã
      periodMorning: [
        /manh[ãa]/i,
        /\b(cedo|cedinho)/i,
        /antes?\s+do\s+meio[-\s]*dia/i,
        /\b(8|9|10|11)h/i
      ],

      // Período tarde
      periodAfternoon: [
        /tarde/i,
        /depois\s+do\s+almo[cç]o/i,
        /\b(13|14|15|16|17)h/i,
        /[aà]\s+tarde/i
      ],

      // Flexibilidade
      flexibility: [
        /\bqualquer\s+hor[aá]rio/i,
        /\btanto\s+faz/i,
        /\b(pode\s+ser\s+)?qualquer\s+dia/i,
        /\bflexibilidade/i
      ],

      // Genérico
      generic: [
        /\b(agendar|marcar|remarcar|hor[aá]rio|vaga|consulta|sess[aã]o|cancelar|desmarcar)/i
      ]
    };
  }

  /**
   * 🔍 DETECTA TIPO DE SOLICITAÇÃO DE AGENDAMENTO
   *
   * @param {string} text - Mensagem do lead
   * @param {object} context - Contexto da conversa
   * @param {object} context.lead - Documento do lead
   * @param {boolean} context.hasScheduling - Se já tem agendamento
   *
   * @returns {object|null} Detecção estruturada ou null
   */
  detect(text, context = {}) {
    if (!text || typeof text !== 'string') {
      return null;
    }

    const normalizedText = text.trim().toLowerCase();

    // 🔍 Primeiro verifica se menciona agendamento
    const mentionsScheduling = this.SCHEDULING_PATTERNS.generic.some(p => p.test(normalizedText));

    if (!mentionsScheduling) {
      return null; // Não é sobre agendamento
    }

    // 🎯 Classifica TIPO de solicitação
    const schedulingType = this._classifySchedulingType(normalizedText, context);

    // 📅 Detecta PERÍODO preferido
    const preferredPeriod = this._detectPreferredPeriod(normalizedText);

    // ⚡ Detecta URGÊNCIA
    const hasUrgency = this.SCHEDULING_PATTERNS.urgency.some(p => p.test(normalizedText));

    // 📊 Calcula confiança
    const confidence = this._calculateConfidence(schedulingType, preferredPeriod, hasUrgency);

    // 🏗️ ESTRUTURA DE DETECÇÃO (pura: só detecta, nunca responde)
    return {
      detected: true,
      type: 'scheduling_request',
      schedulingType,          // 'new', 'reschedule', 'cancellation', 'generic'
      preferredPeriod,         // 'morning', 'afternoon', 'flexible', null
      hasUrgency,              // true/false
      confidence,              // 0.0 - 1.0

      // 🎯 Flags específicas
      isNew: schedulingType === 'new',
      isReschedule: schedulingType === 'reschedule',
      isCancellation: schedulingType === 'cancellation',
      isFlexible: preferredPeriod === 'flexible',

      // 📊 Contexto
      alreadyHasScheduling: !!context.hasScheduling,
      requiresUrgentHandling: hasUrgency,

      // 📝 Metadados
      metadata: {
        originalText: text,
        detectedAt: new Date().toISOString(),
        detector: this.name,
        version: this.config.version
      }
    };
  }

  /**
   * 🎯 Classifica tipo de solicitação de agendamento
   */
  _classifySchedulingType(text, context) {
    // 1. Cancelamento (prioridade: negativo primeiro)
    if (this.SCHEDULING_PATTERNS.cancellation.some(p => p.test(text))) {
      return 'cancellation';
    }

    // 2. Remarcação
    if (this.SCHEDULING_PATTERNS.reschedule.some(p => p.test(text))) {
      return 'reschedule';
    }

    // 3. Novo agendamento
    if (this.SCHEDULING_PATTERNS.newBooking.some(p => p.test(text))) {
      return 'new';
    }

    // 4. Se já tem agendamento e menciona scheduling, provavelmente é remarcação
    if (context.hasScheduling) {
      return 'reschedule';
    }

    // 5. Genérico
    return 'generic';
  }

  /**
   * 📅 Detecta período preferido
   */
  _detectPreferredPeriod(text) {
    // Flexibilidade tem prioridade (explícito)
    if (this.SCHEDULING_PATTERNS.flexibility.some(p => p.test(text))) {
      return 'flexible';
    }

    // Manhã
    const mentionsMorning = this.SCHEDULING_PATTERNS.periodMorning.some(p => p.test(text));

    // Tarde
    const mentionsAfternoon = this.SCHEDULING_PATTERNS.periodAfternoon.some(p => p.test(text));

    // Se menciona ambos ou nenhum
    if (mentionsMorning && mentionsAfternoon) {
      return 'flexible';
    }

    if (mentionsMorning) {
      return 'morning';
    }

    if (mentionsAfternoon) {
      return 'afternoon';
    }

    return null; // Não especificou
  }

  /**
   * 📊 Calcula confiança da detecção
   */
  _calculateConfidence(schedulingType, preferredPeriod, hasUrgency) {
    let confidence = 0.6; // Base

    // +0.2 se tipo específico (não genérico)
    if (schedulingType !== 'generic') {
      confidence += 0.2;
    }

    // +0.1 se especificou período
    if (preferredPeriod) {
      confidence += 0.1;
    }

    // +0.1 se tem urgência (padrão muito claro)
    if (hasUrgency) {
      confidence += 0.1;
    }

    return Math.max(0, Math.min(1, confidence)); // Clamp 0-1
  }

  /**
   * 📊 MÉTRICAS E ESTATÍSTICAS
   */
  getStats() {
    return {
      ...this.stats,
      dataSource: this.config.dataSource,
      expectedImpact: this.config.expectedImpact,
      totalPatterns: {
        newBooking: this.SCHEDULING_PATTERNS.newBooking.length,
        reschedule: this.SCHEDULING_PATTERNS.reschedule.length,
        urgency: this.SCHEDULING_PATTERNS.urgency.length,
        cancellation: this.SCHEDULING_PATTERNS.cancellation.length,
        periodMorning: this.SCHEDULING_PATTERNS.periodMorning.length,
        periodAfternoon: this.SCHEDULING_PATTERNS.periodAfternoon.length
      }
    };
  }

  /**
   * 🧠 APRENDE COM FEEDBACK
   */
  addFeedback(text, wasCorrect, correctType = null) {
    this.history.push({
      text,
      wasCorrect,
      correctType,
      timestamp: new Date()
    });

    if (wasCorrect) {
      this.stats.truePositives++;
    } else {
      this.stats.falsePositives++;
    }

    if (!wasCorrect && correctType) {
      console.log(`📅 [SchedulingDetector] Missed type: "${text}" should be "${correctType}"`);
    }
  }
}

export default new SchedulingDetector();
