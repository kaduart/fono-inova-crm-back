/**
 * Testes do ResponseEnricher
 * Valida que flags emocionais enriquecem as respostas
 */

import { describe, it, expect } from 'vitest';
import { 
  decideEnrichmentLevel, 
  enrichTemplate, 
  ENRICHMENT_LEVEL 
} from '../../services/ResponseEnricher.js';

describe('ResponseEnricher', () => {
  describe('decideEnrichmentLevel', () => {
    it('retorna FULL para isEmotional', () => {
      const flags = { isEmotional: true };
      const level = decideEnrichmentLevel(flags, 'COLLECT_COMPLAINT', {});
      expect(level).toBe(ENRICHMENT_LEVEL.FULL);
    });

    it('retorna FULL para mentionsDoubtTEA', () => {
      const flags = { mentionsDoubtTEA: true };
      const level = decideEnrichmentLevel(flags, 'IDLE', {});
      expect(level).toBe(ENRICHMENT_LEVEL.FULL);
    });

    it('retorna FULL para mentionsPriceObjection', () => {
      const flags = { mentionsPriceObjection: true };
      const level = decideEnrichmentLevel(flags, 'IDLE', {});
      expect(level).toBe(ENRICHMENT_LEVEL.FULL);
    });

    it('retorna LIGHT para isHotLead', () => {
      const flags = { isHotLead: true };
      const level = decideEnrichmentLevel(flags, 'IDLE', {});
      expect(level).toBe(ENRICHMENT_LEVEL.LIGHT);
    });

    it('retorna NONE para fluxo normal sem flags especiais', () => {
      const flags = { asksPrice: true, mentionsChild: true };
      const level = decideEnrichmentLevel(flags, 'COLLECT_THERAPY', {});
      expect(level).toBe(ENRICHMENT_LEVEL.NONE);
    });
  });

  describe('enrichTemplate', () => {
    it('adiciona acolhimento quando isEmotional', () => {
      const template = 'Oi! Como posso ajudar?';
      const flags = { isEmotional: true };
      const lead = { patientGender: 'F' };
      
      const result = enrichTemplate(template, flags, lead, {});
      
      expect(result).toContain('preocupada');
      expect(result).toContain('💚');
      expect(result).toContain('Oi! Como posso ajudar?');
    });

    it('substitui *nome* pelo nome do paciente', () => {
      const template = 'Oi *nome*, tudo bem?';
      const flags = {};
      const lead = {};
      const stateData = { patientName: 'João' };
      
      const result = enrichTemplate(template, flags, lead, stateData);
      
      expect(result).toBe('Oi João, tudo bem?');
    });

    it('substitui *idade* pela idade do paciente', () => {
      const template = 'Entendi, *idade*.';
      const flags = {};
      const lead = {};
      const stateData = { age: 7 };
      
      const result = enrichTemplate(template, flags, lead, stateData);
      
      expect(result).toBe('Entendi, 7 anos.');
    });

    it('não duplica acolhimento se já existe na mensagem', () => {
      const template = 'Entendo sua preocupação. 💚 Como posso ajudar?';
      const flags = { isEmotional: true };
      const lead = {};
      
      const result = enrichTemplate(template, flags, lead, {});
      
      // Não deve adicionar outro acolhimento
      const matches = result.match(/preocup/g);
      expect(matches?.length).toBe(1);
    });
  });
});
