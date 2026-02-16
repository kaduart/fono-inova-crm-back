/**
 * 🏥 INSURANCE DETECTOR (Detecção Pura)
 *
 * Detecta perguntas sobre planos de saúde/convênios com granularidade específica.
 *
 * 📊 IMPACTO:
 * - 18.4% do volume total de intents (261 ocorrências em dados reais)
 * - "Unimed" sozinho: 103 menções (39.5% dos casos de plano)
 * - Redução esperada de insistência em plano: -60%
 * - Aumento de conversão plano → agendamento: +15-25pp
 *
 * 🏗️ ARQUITETURA (CRITICAL):
 * - ⚠️ APENAS DETECTA — NÃO GERA RESPOSTAS
 * - Retorna estrutura rica: plano específico + confiança
 * - Orchestrator decide resposta usando clinicWisdom.js
 * - Evita criar motor de resposta paralelo
 */

import { BaseDetector } from './BaseDetector.js';

export class InsuranceDetector {
  constructor() {
    this.name = 'InsuranceDetector';
    this.config = {
      version: '1.0.0',
      dataSource: 'whatsapp_export_2026-02-13.txt (261 ocorrências)',
      expectedImpact: '-60% insistência, +15-25pp conversão'
    };

    this.stats = {
      totalDetections: 0,
      truePositives: 0,
      falsePositives: 0
    };

    this.history = [];

    // 📊 Padrões extraídos de dados reais
    this.PLAN_PATTERNS = {
      // Planos específicos detectados nos dados reais
      unimed: {
        patterns: [
          /\bunimed\b/i,
          /\buni\s*med\b/i
        ],
        frequency: 103,  // 39.5% dos casos de plano
        aliases: ['unimed', 'uni med']
      },

      ipasgo: {
        patterns: [
          /\bipasgo\b/i,
          /\bipa\s*sgo\b/i
        ],
        frequency: 45,   // Segundo mais comum
        aliases: ['ipasgo', 'ipa sgo']
      },

      bradesco: {
        patterns: [
          /\bbradesco\s*(sa[uú]de)?\b/i,
          /\bbradesco\s*dental\b/i
        ],
        frequency: 28,
        aliases: ['bradesco saúde', 'bradesco dental', 'bradesco']
      },

      amil: {
        patterns: [
          /\bamil\b/i
        ],
        frequency: 22,
        aliases: ['amil']
      },

      sulamerica: {
        patterns: [
          /\bsul\s*am[eé]rica\b/i,
          /\bsulam[eé]rica\b/i
        ],
        frequency: 15,
        aliases: ['sul américa', 'sulamérica']
      },

      hapvida: {
        patterns: [
          /\bhapvida\b/i,
          /\bhap\s*vida\b/i
        ],
        frequency: 12,
        aliases: ['hapvida', 'hap vida']
      },

      outros: {
        patterns: [
          /\b(cassi|geap|cabesp|postal\s*sa[uú]de|prevent\s*senior)\b/i
        ],
        frequency: 36,
        aliases: ['outros']
      }
    };

    // 🎯 Padrões de intenção (pergunta vs afirmação)
    this.INTENT_PATTERNS = {
      question: [
        /\b(aceita|aceitam|atende|atendem|trabalha|trabalham|pega|pegam)\b.*\b(plano|conv[êe]nio)\b/i,
        /\b(plano|conv[êe]nio)\b.*\b(aceita|aceitam|atende|atendem)\b/i,
        /\b(tem|fazem?|possui)\b.*\b(plano|conv[êe]nio)\b/i,
        /\b(qual|quais)\b.*\b(plano|conv[êe]nio)\b/i,
        /\b(aceita|atende)\b.*\b(unimed|ipasgo|amil|bradesco)\b/i
      ],

      statement: [
        /\b(tenho|eu tenho|meu filho tem)\b.*\b(plano|conv[êe]nio)\b/i,
        /\b(tenho|eu tenho|meu filho tem)\b.*\b(unimed|ipasgo|amil|bradesco|hapvida)\b/i,  // Específico
        /\b(sou|somos)\b.*\b(unimed|ipasgo|amil)\b/i,
        /\b(pelo|com o|via)\b.*\b(plano|conv[êe]nio)\b/i
      ],

      concern: [
        /\b(s[oó]|apenas|somente)\b.*\b(plano|conv[êe]nio)\b/i,
        /\b(n[aã]o tenho|sem)\b.*\b(plano|conv[êe]nio)\b/i,
        /\b(particular|privado)\b/i
      ]
    };

    // 📋 Tipos genéricos (quando não há plano específico)
    this.GENERIC_PATTERNS = [
      /\b(plano|conv[êe]nio|plano de sa[uú]de)\b/i,
      /\breembolso\b/i
    ];
  }

  /**
   * 🔍 DETECTA MENÇÃO A PLANO/CONVÊNIO
   *
   * @param {string} text - Mensagem do lead
   * @param {object} context - Contexto da conversa
   *
   * @returns {object|null} Detecção estruturada ou null
   */
  detect(text, context = {}) {
    if (!text || typeof text !== 'string') {
      return null;
    }

    const normalizedText = text.toLowerCase().trim();

    // 🔍 FASE 1: Detecta plano específico
    const specificPlan = this._detectSpecificPlan(normalizedText);

    // 🔍 FASE 2: Se não achou específico, verifica genérico
    const isGeneric = !specificPlan && this._isGenericPlanMention(normalizedText);

    if (!specificPlan && !isGeneric) {
      return null; // Não mencionou plano
    }

    // 🎯 FASE 3: Classifica intenção (pergunta, afirmação, preocupação)
    const intentType = this._classifyIntent(normalizedText);

    // 📊 FASE 4: Calcula confiança
    const confidence = this._calculateConfidence(specificPlan, intentType);

    // 🏗️ ESTRUTURA DE DETECÇÃO (PURA: só detecta, nunca responde)
    return {
      detected: true,
      type: 'insurance_inquiry',

      // 🎯 Dados específicos
      plan: specificPlan ? specificPlan.name : 'generic',
      planAliases: specificPlan ? specificPlan.aliases : ['plano', 'convênio'],
      frequency: specificPlan ? specificPlan.frequency : null,

      // 🎭 Intenção
      intentType,                 // 'question', 'statement', 'concern'
      confidence,                 // 0.0 - 1.0

      // 🔍 Análise
      isSpecific: !!specificPlan,
      requiresClarification: !specificPlan || intentType === 'concern',

      // 📝 Metadados
      metadata: {
        originalText: text,
        detectedAt: new Date().toISOString(),
        detector: this.name,
        version: this.config.version
      },

      // 💡 HINT PARA ORCHESTRATOR (não é resposta, é sugestão de fonte)
      // Orchestrator pode usar clinicWisdom.CONVENIO_WISDOM[plan] se existir
      wisdomKey: specificPlan ? specificPlan.name : null
    };
  }

  /**
   * 🔍 Detecta plano específico
   */
  _detectSpecificPlan(text) {
    for (const [planName, planConfig] of Object.entries(this.PLAN_PATTERNS)) {
      const matched = planConfig.patterns.some(pattern => pattern.test(text));

      if (matched) {
        return {
          name: planName,
          aliases: planConfig.aliases,
          frequency: planConfig.frequency
        };
      }
    }

    return null;
  }

  /**
   * 🔍 Verifica menção genérica a plano
   */
  _isGenericPlanMention(text) {
    return this.GENERIC_PATTERNS.some(pattern => pattern.test(text));
  }

  /**
   * 🎯 Classifica tipo de intenção
   */
  _classifyIntent(text) {
    if (this.INTENT_PATTERNS.question.some(p => p.test(text))) {
      return 'question';
    }

    if (this.INTENT_PATTERNS.statement.some(p => p.test(text))) {
      return 'statement';
    }

    if (this.INTENT_PATTERNS.concern.some(p => p.test(text))) {
      return 'concern';
    }

    return 'question'; // Default: trata como pergunta
  }

  /**
   * 📊 Calcula confiança da detecção
   */
  _calculateConfidence(specificPlan, intentType) {
    let confidence = 0.5; // Base

    // +0.3 se detectou plano específico
    if (specificPlan) {
      confidence += 0.3;
    }

    // +0.2 se é pergunta clara (intenção mais direta)
    if (intentType === 'question') {
      confidence += 0.2;
    }

    // +0.1 se é plano comum (alta frequência nos dados)
    if (specificPlan && specificPlan.frequency > 50) {
      confidence += 0.1;
    }

    // -0.1 se é preocupação (ambíguo)
    if (intentType === 'concern') {
      confidence -= 0.1;
    }

    return Math.max(0, Math.min(1, confidence)); // Clamp 0-1
  }

  /**
   * 📊 MÉTRICAS E ESTATÍSTICAS
   */
  getStats() {
    const totalFrequency = Object.values(this.PLAN_PATTERNS)
      .reduce((sum, plan) => sum + plan.frequency, 0);

    return {
      ...this.stats,
      dataSource: this.config.dataSource,
      expectedImpact: this.config.expectedImpact,
      plansCatalog: Object.keys(this.PLAN_PATTERNS).length,
      totalDetectionsInTraining: totalFrequency,
      topPlan: {
        name: 'unimed',
        frequency: this.PLAN_PATTERNS.unimed.frequency,
        percentage: ((this.PLAN_PATTERNS.unimed.frequency / totalFrequency) * 100).toFixed(1) + '%'
      }
    };
  }

  /**
   * 🧠 APRENDE COM FEEDBACK
   */
  addFeedback(text, wasCorrect, correctPlan = null) {
    this.history.push({
      text,
      wasCorrect,
      correctPlan,
      timestamp: new Date()
    });

    if (wasCorrect) {
      this.stats.truePositives++;
    } else {
      this.stats.falsePositives++;
    }

    if (!wasCorrect && correctPlan) {
      console.log(`🏥 [InsuranceDetector] Missed plan: "${text}" should be "${correctPlan}"`);

      // TODO (Fase 4): Auto-gera novo padrão se confiável
    }
  }

  /**
   * 📋 LISTA DE PLANOS SUPORTADOS (útil para debugging/admin)
   */
  getSupportedPlans() {
    return Object.entries(this.PLAN_PATTERNS)
      .sort((a, b) => b[1].frequency - a[1].frequency)
      .map(([name, config]) => ({
        name,
        aliases: config.aliases,
        frequency: config.frequency,
        percentage: ((config.frequency / 261) * 100).toFixed(1) + '%'
      }));
  }
}

export default new InsuranceDetector();
