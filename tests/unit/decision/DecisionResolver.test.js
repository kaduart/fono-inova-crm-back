/**
 * Testes para DecisionResolver
 * Valida a lógica de 2 níveis: Domain Selection + Action Decision
 */

import { describe, it, expect } from 'vitest';
import { resolveDecision, extractDetectorResults, isAmbiguousDecision, DOMAIN_CONFIG } from '../../../orchestrators/decision/DecisionResolver.js';

describe('DecisionResolver', () => {
  
  // ═════════════════════════════════════════════════════════════════════════════
  // TESTES DE FORCE FLAGS (Override Absoluto)
  // ═════════════════════════════════════════════════════════════════════════════
  
  describe('Force Flags Override', () => {
    it('forceExplainFirst deve retornar AI independente de detectors', () => {
      const result = resolveDecision({
        forceFlags: { forceExplainFirst: true },
        detectorResults: {
          price: { detected: true, confidence: 0.95, priceType: 'insistence' }
        }
      });
      
      expect(result.action).toBe('AI');
      expect(result.domain).toBe('general');
      expect(result.reason).toBe('FORCE_EXPLAIN_FIRST');
      expect(result.priority).toBe(100);
    });
    
    it('forceEmpathy deve retornar AI', () => {
      const result = resolveDecision({
        forceFlags: { forceEmpathy: true },
        detectorResults: {
          scheduling: { detected: true, confidence: 0.9, intentType: 'urgent' }
        }
      });
      
      expect(result.action).toBe('AI');
      expect(result.domain).toBe('general');
      expect(result.reason).toBe('FORCE_EMPATHY');
    });
    
    it('forcePrice com alta confiança retorna RULE', () => {
      const result = resolveDecision({
        forceFlags: { forcePrice: true },
        detectorResults: {
          price: { detected: true, confidence: 0.95, priceType: 'insistence' }
        }
      });
      
      expect(result.action).toBe('RULE');
      expect(result.domain).toBe('price');
      expect(result.reason).toBe('FORCE_PRICE_HIGH_CONF');
    });
    
    it('forcePrice sem detector price retorna HYBRID default', () => {
      const result = resolveDecision({
        forceFlags: { forcePrice: true },
        detectorResults: {}
      });
      
      expect(result.action).toBe('HYBRID');
      expect(result.domain).toBe('price');
    });
  });
  
  // ═════════════════════════════════════════════════════════════════════════════
  // TESTES DE SELEÇÃO DE DOMÍNIO (Nível 1)
  // ═════════════════════════════════════════════════════════════════════════════
  
  describe('Domain Selection (Level 1)', () => {
    it('deve selecionar price quando confidence alta', () => {
      const result = resolveDecision({
        forceFlags: {},
        detectorResults: {
          price: { detected: true, confidence: 0.9, priceType: 'insistence' }
        },
        currentState: 'IDLE'
      });
      
      expect(result.domain).toBe('price');
      expect(result.score).toBeGreaterThan(0.9); // Com peso do tipo
    });
    
    it('deve selecionar scheduling quando confidence alta', () => {
      const result = resolveDecision({
        forceFlags: {},
        detectorResults: {
          scheduling: { detected: true, confidence: 0.85, intentType: 'urgent' }
        },
        currentState: 'IDLE'
      });
      
      expect(result.domain).toBe('scheduling');
      expect(result.score).toBeGreaterThan(1.0); // 0.85 * 1.3 (urgent)
    });
    
    it('deve preferir confirmation quando tem slot pendente', () => {
      const result = resolveDecision({
        forceFlags: {},
        detectorResults: {
          price: { detected: true, confidence: 0.8, priceType: 'generic' },
          confirmation: { detected: true, confidence: 0.75, confirmationType: 'accept_slot', slotPending: true }
        },
        enrichedContext: { lead: { pendingSchedulingSlots: [{ id: 1 }] } },
        currentState: 'SCHEDULING'
      });
      
      // Confirmation deve ganhar por causa do multiplicador slotPending (1.2) + accept_slot (1.4)
      expect(result.domain).toBe('confirmation');
    });
    
    it('deve retornar domain=null quando nenhum detector ativo', () => {
      const result = resolveDecision({
        forceFlags: {},
        detectorResults: {}
      });
      
      expect(result.domain).toBeNull();
      expect(result.action).toBe('AI');
      expect(result.reason).toBe('NO_DOMAIN_DETECTED');
    });
  });
  
  // ═════════════════════════════════════════════════════════════════════════════
  // TESTES DE DECISÃO DE AÇÃO (Nível 2)
  // ═════════════════════════════════════════════════════════════════════════════
  
  describe('Action Decision (Level 2)', () => {
    it('price com confidence >= 0.85*1.2=1.02 deve retornar RULE', () => {
      const result = resolveDecision({
        forceFlags: {},
        detectorResults: {
          price: { detected: true, confidence: 0.9, priceType: 'insistence' }
          // rawScore = 0.9 * 1.2 = 1.08 (acima do RULE 0.85)
        }
      });
      
      expect(result.action).toBe('RULE');
      expect(result.domain).toBe('price');
    });
    
    it('price com confidence 0.65*1.2=0.78 deve retornar HYBRID', () => {
      const result = resolveDecision({
        forceFlags: {},
        detectorResults: {
          price: { detected: true, confidence: 0.65, priceType: 'insistence' }
          // rawScore = 0.65 * 1.2 = 0.78 (entre 0.60 e 0.85)
        }
      });
      
      expect(result.action).toBe('HYBRID');
    });
    
    it('price com confidence 0.4 deve retornar AI', () => {
      const result = resolveDecision({
        forceFlags: {},
        detectorResults: {
          price: { detected: true, confidence: 0.4, priceType: 'insistence' }
          // rawScore = 0.4 * 1.2 = 0.48 (abaixo do HYBRID 0.60)
        }
      });
      
      expect(result.action).toBe('AI');
    });
    
    it('confirmation com confidence >= 0.9 deve retornar RULE', () => {
      const result = resolveDecision({
        forceFlags: {},
        detectorResults: {
          confirmation: { detected: true, confidence: 0.95, confirmationType: 'accept_slot' }
          // rawScore = 0.95 * 1.4 = 1.33
        }
      });
      
      expect(result.action).toBe('RULE');
      expect(result.domain).toBe('confirmation');
    });
  });
  
  // ═════════════════════════════════════════════════════════════════════════════
  // TESTES DE AMBIGUIDADE
  // ═════════════════════════════════════════════════════════════════════════════
  
  describe('Ambiguity Detection', () => {
    it('deve detectar ambiguidade quando domínios muito próximos', () => {
      const decision = resolveDecision({
        forceFlags: {},
        detectorResults: {
          price: { detected: true, confidence: 0.8, priceType: 'generic' }, // 0.8 * 0.7 = 0.56
          scheduling: { detected: true, confidence: 0.75, intentType: 'generic' } // 0.75 * 0.8 = 0.6
        }
      });
      
      expect(decision.context.isAmbiguous).toBe(true);
    });
    
    it('deve considerar decisão clara quando domínios distantes', () => {
      const decision = resolveDecision({
        forceFlags: {},
        detectorResults: {
          price: { detected: true, confidence: 0.95, priceType: 'insistence' }, // ~1.14
          scheduling: { detected: true, confidence: 0.5, intentType: 'generic' } // 0.4
        }
      });
      
      expect(decision.context.isAmbiguous).toBe(false);
    });
  });
  
  // ═════════════════════════════════════════════════════════════════════════════
  // TESTES DE CONTEXT MULTIPLIERS
  // ═════════════════════════════════════════════════════════════════════════════
  
  describe('Context Multipliers', () => {
    it('priceAlreadyMentioned deve aumentar score de price', () => {
      const result = resolveDecision({
        forceFlags: {},
        detectorResults: {
          price: { detected: true, confidence: 0.8, priceType: 'insistence', alreadyMentioned: true }
          // rawScore = 0.8 * 1.2 * 1.15 = 1.104
        }
      });
      
      expect(result.domain).toBe('price');
      expect(result.score).toBeGreaterThan(1.0);
    });
  });
  
  // ═════════════════════════════════════════════════════════════════════════════
  // TESTES DE extractDetectorResults
  // ═════════════════════════════════════════════════════════════════════════════
  
  describe('extractDetectorResults', () => {
    it('deve extrair corretamente das flags do DetectorAdapter', () => {
      const flags = {
        wantsPrice: true,
        _price: { detected: true, confidence: 0.85, priceType: 'insistence' },
        _scheduling: { detected: false },
        _confirmation: { detected: true, confidence: 0.7, confirmationType: 'tentative' },
        _insurance: { detected: false }
      };
      
      const result = extractDetectorResults(flags);
      
      expect(result.price.detected).toBe(true);
      expect(result.price.confidence).toBe(0.85);
      expect(result.confirmation.detected).toBe(true);
      expect(result.scheduling.detected).toBe(false);
    });
  });
  
  // ═════════════════════════════════════════════════════════════════════════════
  // TESTES DE INTEGRAÇÃO (Cenários Reais)
  // ═════════════════════════════════════════════════════════════════════════════
  
  describe('Integration Scenarios', () => {
    it('Cenário: "Quanto custa?" - Primeira mensagem', () => {
      const decision = resolveDecision({
        forceFlags: {},
        detectorResults: {
          price: { detected: true, confidence: 0.9, priceType: 'insistence', isEarlyQuestion: true }
        },
        currentState: 'IDLE',
        messageIndex: 1,
        enrichedContext: {}
      });
      
      expect(decision.domain).toBe('price');
      expect(decision.action).toBe('RULE'); // Alta confiança
    });
    
    it('Cenário: "Quero marcar urgente" - Com slot pendente', () => {
      const decision = resolveDecision({
        forceFlags: {},
        detectorResults: {
          scheduling: { detected: true, confidence: 0.85, intentType: 'urgent' }
        },
        currentState: 'SCHEDULING',
        enrichedContext: {
          lead: { pendingSchedulingSlots: [{ id: 'slot1' }] }
        }
      });
      
      expect(decision.domain).toBe('scheduling');
      expect(decision.action).toBe('RULE');
      expect(decision.context.type).toBe('urgent');
    });
    
    it('Cenário: "Pode ser" - Confirmação ambígua', () => {
      const decision = resolveDecision({
        forceFlags: {},
        detectorResults: {
          confirmation: { detected: true, confidence: 0.5, confirmationType: 'ambiguous' }
          // rawScore = 0.5 * 0.6 = 0.3 - muito baixo
        }
      });
      
      // Confidence baixa, deve usar IA
      expect(decision.action).toBe('AI');
      expect(decision.reason).toContain('LOW');
    });
    
    it('Cenário: Force flags vencem sobre detectors', () => {
      const decision = resolveDecision({
        forceFlags: { forceEmpathy: true },
        detectorResults: {
          price: { detected: true, confidence: 0.99, priceType: 'insistence' },
          confirmation: { detected: true, confidence: 0.95, confirmationType: 'accept_slot' }
        }
      });
      
      // ForceEmpathy deve vencer sobre os detectores altos
      expect(decision.action).toBe('AI');
      expect(decision.reason).toBe('FORCE_EMPATHY');
      expect(decision.priority).toBe(100);
    });
  });
});
