/**
 * Testes de fluxos de conversa em ordens variadas
 * 
 * Simula diferentes sequências de mensagens que leads reais enviam no WhatsApp,
 * garantindo que o sistema coleta nome, idade e período independente da ordem.
 */

import { describe, it, expect } from 'vitest';

// Importar funções de extração do patientDataExtractor
import { 
  extractName, 
  extractAgeFromText, 
  extractPeriodFromText 
} from '../../utils/patientDataExtractor.js';

// Versão simplificada de getMissingFields para testes (sem dependência de MongoDB)
function getMissingFields(lead, extracted = {}, text = '') {
  const missing = [];
  const hasName = lead?.patientInfo?.fullName || extracted?.patientName;
  const hasAge = lead?.patientInfo?.age || extracted?.patientAge;
  
  // Skip complaint if asking about insurance/plans
  const isInsuranceQuestion = /\b(unimed|ipasgo|amil|bradesco|sulam[eé]rica|plano|conv[eê]nio|reembolso)\b/i.test(text);
  
  if (!hasName)
    missing.push('nome do paciente');
  if (!hasAge)
    missing.push('idade');
  if (!lead?.pendingPreferredPeriod && !extracted?.period)
    missing.push('período (manhã ou tarde)');
  if (!lead?.therapyArea && !extracted?.therapyArea)
    missing.push('área terapêutica');
  // Only ask complaint if we have basics AND not asking about insurance
  if (hasName && hasAge && !lead?.complaint && !isInsuranceQuestion)
    missing.push('queixa principal');
  return missing;
}

// Simula o comportamento de persistExtractedData sem BD
function simulePersist(lead, text) {
  const n = extractName(text);
  const a = extractAgeFromText(text);
  const p = extractPeriodFromText(text);
  if (n && !lead.patientInfo?.fullName) {
    lead.patientInfo = lead.patientInfo || {};
    lead.patientInfo.fullName = n;
  }
  if (a && !lead.patientInfo?.age) {
    lead.patientInfo = lead.patientInfo || {};
    lead.patientInfo.age = typeof a === 'object' ? a.age : a;
  }
  if (p && !lead.pendingPreferredPeriod) {
    lead.pendingPreferredPeriod = p;
  }
  return lead;
}

describe('Fluxos de conversa em ordens variadas', () => {

  describe('Fluxo A: Linear (ordem ideal)', () => {
    it('nome → idade → período → todos coletados', () => {
      let lead = {};
      lead = simulePersist(lead, 'Ana Paula Matos');
      lead = simulePersist(lead, 'ela tem 5 anos');
      lead = simulePersist(lead, 'prefiro de manhã');
      expect(lead.patientInfo?.fullName).toBeTruthy();
      expect(lead.patientInfo?.age).toBe(5);
      expect(lead.pendingPreferredPeriod).toBe('manha');
      const missing = getMissingFields(lead, {});
      expect(missing).not.toContain('nome do paciente');
      expect(missing).not.toContain('idade');
      expect(missing).not.toContain('período (manhã ou tarde)');
    });
  });

  describe('Fluxo B: Preço primeiro', () => {
    it('preço → nome → idade → dados coletados mesmo assim', () => {
      let lead = {};
      lead = simulePersist(lead, 'Quanto custa a avaliação?'); // não extrai dados
      lead = simulePersist(lead, 'Ana Paula Matos');
      lead = simulePersist(lead, 'ela tem 5 anos');
      expect(lead.patientInfo?.fullName).toBeTruthy();
      expect(lead.patientInfo?.age).toBe(5);
    });
  });

  describe('Fluxo C: Tudo junto na primeira mensagem', () => {
    it('mensagem com idade e período simultaneamente', () => {
      let lead = {};
      lead = simulePersist(lead, 'Quero agendar para meu filho de 4 anos, prefiro tarde');
      expect(lead.patientInfo?.age).toBe(4);
      expect(lead.pendingPreferredPeriod).toBe('tarde');
    });
  });

  describe('Fluxo D: Ordem inversa', () => {
    it('período → nome → idade', () => {
      let lead = {};
      lead = simulePersist(lead, 'Só consigo de manhã');
      lead = simulePersist(lead, 'Me chamo Fernanda Lima');
      lead = simulePersist(lead, 'Minha filha tem 3 anos');
      expect(lead.pendingPreferredPeriod).toBe('manha');
      expect(lead.patientInfo?.fullName).toBeTruthy();
      expect(lead.patientInfo?.age).toBe(3);
    });
  });

  describe('Fluxo E: Dados não sobrescritos', () => {
    it('segunda mensagem com nome diferente NÃO sobrescreve o primeiro', () => {
      let lead = {};
      lead = simulePersist(lead, 'Me chamo Carlos Eduardo');
      const nomeOriginal = lead.patientInfo?.fullName;
      lead = simulePersist(lead, 'Perguntar sobre Carlos Eduardo Souza');
      expect(lead.patientInfo?.fullName).toBe(nomeOriginal); // não muda
    });

    it('segunda mensagem com idade NÃO sobrescreve', () => {
      let lead = { patientInfo: { age: 5 } };
      lead = simulePersist(lead, 'ela tem 7 anos');
      expect(lead.patientInfo.age).toBe(5); // mantém original
    });
  });

  describe('Fluxo F: Casos reais do WhatsApp export', () => {
    it('detecta "meu filho tem autismo, 6 anos"', () => {
      let lead = {};
      lead = simulePersist(lead, 'meu filho tem autismo, 6 anos');
      expect(lead.patientInfo?.age).toBe(6);
    });

    it('detecta "ele nao fala ainda, tem 2 aninhos"', () => {
      let lead = {};
      lead = simulePersist(lead, 'ele nao fala ainda, tem 2 aninhos');
      expect(lead.patientInfo?.age).toBe(2);
    });

    it('detecta "só de tarde pq de manhã trabalho"', () => {
      let lead = {};
      lead = simulePersist(lead, 'só de tarde pq de manhã trabalho');
      // Deve capturar 'tarde' (primeira menção de período)
      expect(lead.pendingPreferredPeriod).toBe('tarde');
    });
  });

});
