/**
 * 🧠 BASE DETECTOR - Classe abstrata para todos os detectores de intenção
 *
 * FILOSOFIA:
 * - Detecção pura, sem lógica de negócio
 * - Extensível via herança
 * - Suporta aprendizado incremental
 * - Fornece debugging/observabilidade
 */

import Logger from '../services/utils/Logger.js';

export class BaseDetector {
  constructor(name, config = {}) {
    this.name = name;
    this.patterns = config.patterns || [];
    this.contextRules = config.contextRules || [];
    this.confidenceThreshold = config.confidenceThreshold || 0.7;
    this.history = []; // Para feedback e learning
    this.logger = new Logger(`Detector:${name}`);

    // Estatísticas
    this.stats = {
      totalDetections: 0,
      truePositives: 0,
      falsePositives: 0,
      lastUpdate: new Date()
    };
  }

  /**
   * 🎯 MÉTODO PRINCIPAL DE DETECÇÃO
   * Deve ser sobrescrito pelas subclasses
   */
  detect(text, context = {}) {
    throw new Error(`detect() must be implemented in ${this.name} detector`);
  }

  /**
   * 🔍 MATCH DE PADRÕES BASE
   * Aplica todos os padrões configurados e retorna score agregado
   */
  matchPatterns(text, patterns) {
    if (!text || !patterns || patterns.length === 0) return 0;

    const normalizedText = text.toLowerCase().trim();
    let totalScore = 0;
    const matches = [];

    for (const patternConfig of patterns) {
      const pattern = patternConfig.pattern || patternConfig;
      const weight = patternConfig.weight || 1.0;

      let match;
      if (pattern instanceof RegExp) {
        match = normalizedText.match(pattern);
      } else if (typeof pattern === 'string') {
        match = normalizedText.includes(pattern.toLowerCase());
      }

      if (match) {
        const score = weight;
        totalScore += score;
        matches.push({
          pattern: pattern.source || pattern,
          weight,
          score,
          matched: Array.isArray(match) ? match[0] : pattern
        });
      }
    }

    return {
      score: totalScore,
      matches,
      normalized: totalScore / Math.max(patterns.length, 1) // Score normalizado 0-1
    };
  }

  /**
   * 📊 CALCULA CONFIANÇA FINAL
   * Combina score base, contexto e histórico
   */
  calculateConfidence(scores, context = {}) {
    const { base = 0, learned = 0, contextual = 0 } = scores;

    // Pesos configuráveis
    const baseWeight = 0.6;
    const learnedWeight = 0.2;
    const contextWeight = 0.2;

    const confidence =
      base * baseWeight +
      learned * learnedWeight +
      contextual * contextWeight;

    // Normaliza para 0-1
    return Math.min(confidence, 1.0);
  }

  /**
   * 🎓 APRENDIZADO: Adiciona feedback
   * wasCorrect: boolean - se a detecção estava correta
   * correctIntent: string - qual era a intenção real (se wasCorrect = false)
   */
  addFeedback(text, wasCorrect, correctIntent = null) {
    const entry = {
      text,
      wasCorrect,
      correctIntent,
      timestamp: Date.now(),
      detectorName: this.name
    };

    this.history.push(entry);

    // Atualiza estatísticas
    this.stats.totalDetections++;
    if (wasCorrect) {
      this.stats.truePositives++;
    } else {
      this.stats.falsePositives++;
    }

    // Se foi falso negativo (deveria detectar mas não detectou)
    if (!wasCorrect && correctIntent === this.name) {
      this.generatePatternFromExample(text);
    }

    // Limita histórico a últimos 1000 exemplos
    if (this.history.length > 1000) {
      this.history = this.history.slice(-1000);
    }

    this.logger.debug('FEEDBACK_ADDED', {
      wasCorrect,
      correctIntent,
      textPreview: text.substring(0, 50),
      accuracy: this.getAccuracy()
    });
  }

  /**
   * 🧬 GERA PADRÃO AUTOMÁTICO A PARTIR DE EXEMPLO
   * Heurística simples: extrai n-grams significativos
   */
  generatePatternFromExample(text) {
    const tokens = this.tokenize(text);
    const significant = tokens.filter(
      t => t.length > 3 && !this.isStopWord(t)
    );

    if (significant.length === 0) {
      this.logger.warn('NO_PATTERN_GENERATED', { text });
      return null;
    }

    // Cria padrão com até 3 tokens mais significativos
    const topTokens = significant.slice(0, 3);
    const patternStr = topTokens.join('\\s+');
    const pattern = new RegExp(patternStr, 'i');

    // Adiciona aos padrões aprendidos com peso baixo inicial
    const newPattern = {
      pattern,
      weight: 0.3,
      source: 'auto-generated',
      examples: [text],
      createdAt: new Date()
    };

    this.patterns.push(newPattern);

    this.logger.info('PATTERN_LEARNED', {
      pattern: patternStr,
      source: text.substring(0, 50)
    });

    return newPattern;
  }

  /**
   * 🔤 TOKENIZAÇÃO SIMPLES
   */
  tokenize(text) {
    return (text || '')
      .toLowerCase()
      .replace(/[^\w\sáàâãéêíóôõúüç]/g, '')
      .split(/\s+/)
      .filter(t => t.length > 0);
  }

  /**
   * 🚫 STOP WORDS (palavras comuns sem significado)
   */
  isStopWord(word) {
    const stopWords = [
      'a', 'o', 'as', 'os',
      'de', 'da', 'do', 'das', 'dos',
      'em', 'no', 'na', 'nos', 'nas',
      'por', 'para', 'pra',
      'com', 'sem',
      'um', 'uma', 'uns', 'umas',
      'e', 'ou', 'mas',
      'que', 'qual',
      'esse', 'essa', 'isso',
      'este', 'esta', 'isto',
      'meu', 'minha', 'seu', 'sua',
      'é', 'foi', 'ser', 'ter',
      'muito', 'mais', 'menos'
    ];

    return stopWords.includes(word.toLowerCase());
  }

  /**
   * 📈 MÉTRICAS DE PERFORMANCE
   */
  getAccuracy() {
    if (this.stats.totalDetections === 0) return 0;
    return (this.stats.truePositives / this.stats.totalDetections).toFixed(2);
  }

  getPrecision() {
    const detections = this.stats.truePositives + this.stats.falsePositives;
    if (detections === 0) return 0;
    return (this.stats.truePositives / detections).toFixed(2);
  }

  getStats() {
    return {
      ...this.stats,
      accuracy: this.getAccuracy(),
      precision: this.getPrecision(),
      totalPatterns: this.patterns.length,
      learnedPatterns: this.patterns.filter(p => p.source === 'auto-generated').length
    };
  }

  /**
   * 💾 EXPORTA PADRÕES APRENDIDOS
   * Para persistir em arquivo ou banco de dados
   */
  exportLearnedPatterns() {
    return this.patterns
      .filter(p => p.source === 'auto-generated')
      .map(p => ({
        pattern: p.pattern.source,
        weight: p.weight,
        examples: p.examples,
        createdAt: p.createdAt
      }));
  }

  /**
   * 📥 IMPORTA PADRÕES APRENDIDOS
   */
  importLearnedPatterns(patterns) {
    for (const p of patterns) {
      this.patterns.push({
        pattern: new RegExp(p.pattern, 'i'),
        weight: p.weight,
        source: 'imported',
        examples: p.examples || [],
        createdAt: new Date(p.createdAt)
      });
    }

    this.logger.info('PATTERNS_IMPORTED', { count: patterns.length });
  }

  /**
   * 🔍 DEBUG: Mostra por que detectou ou não detectou
   */
  explain(text, result) {
    const explanation = {
      detector: this.name,
      text: text.substring(0, 100),
      detected: result.detected,
      confidence: result.confidence,
      threshold: this.confidenceThreshold,
      matches: result.matches || [],
      scores: result.scores || {},
      decision: result.detected ? 'DETECTED' : 'NOT_DETECTED',
      reason: result.detected
        ? `Confidence ${result.confidence} >= threshold ${this.confidenceThreshold}`
        : `Confidence ${result.confidence} < threshold ${this.confidenceThreshold}`
    };

    this.logger.debug('DETECTION_EXPLANATION', explanation);
    return explanation;
  }

  /**
   * 🧹 LIMPA HISTÓRICO ANTIGO
   */
  cleanupHistory(daysToKeep = 30) {
    const cutoff = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
    const before = this.history.length;

    this.history = this.history.filter(h => h.timestamp > cutoff);

    const removed = before - this.history.length;
    if (removed > 0) {
      this.logger.info('HISTORY_CLEANUP', {
        removed,
        remaining: this.history.length
      });
    }
  }
}

export default BaseDetector;
