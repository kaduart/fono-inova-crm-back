// back/tests/amanda/contracts/intentContracts.test.js
/**
 * Contract Tests para Intents da Amanda
 * 
 * Testes determinísticos que validam contratos de intents.
 * 
 * Estes testes são:
 * - Síncronos (sem async externo)
 * - Determinísticos (mesmo input = mesmo output)
 * - Rápidos (< 10ms cada)
 * - Isolados (sem dependências)
 */

import { describe, it, expect } from 'vitest';
import { AmandaTestClient } from '../AmandaTestClient.js';
import { processMessageSync } from '../amandaTestMode.js';

describe('Contract Tests - Intents Principais', () => {
  
  describe('AGENDAMENTO', () => {
    it('Detecta intent de agendamento simples', async () => {
      const result = processMessageSync('quero agendar uma consulta');
      expect(result.intent).toBe('AGENDAMENTO');
      expect(result.response).toContain('especialidade');
    });
    
    it('Detecta agendamento com terapia específica', async () => {
      const result = processMessageSync('quero agendar fonoaudiologia');
      expect(result.intent).toBe('AGENDAMENTO');
      expect(result.extracted.therapyArea).toBeTruthy();
    });
    
    it('Detecta agendamento com variações de texto', async () => {
      const result = processMessageSync('gostaria de marcar um horário para psicologia');
      expect(result.intent).toBe('AGENDAMENTO');
    });
  });
  
  describe('PERGUNTA_PRECO', () => {
    it('Detecta pergunta sobre preço', async () => {
      const result = processMessageSync('quanto custa a consulta?');
      expect(result.intent).toBe('PERGUNTA_PRECO');
    });
    
    it('Detecta variações de pergunta de preço', async () => {
      const result = processMessageSync('qual o valor da sessão?');
      expect(result.intent).toBe('PERGUNTA_PRECO');
    });
  });
  
  describe('PERGUNTA_CONVENIO', () => {
    it('Detecta pergunta sobre convênio', async () => {
      const result = processMessageSync('vocês atendem pela Amil?');
      expect(result.intent).toBe('PERGUNTA_CONVENIO');
    });
    
    it('Detecta pergunta sobre plano de saúde', async () => {
      const result = processMessageSync('aceitam Unimed?');
      expect(result.intent).toBe('PERGUNTA_CONVENIO');
    });
  });
  
  describe('INFORMACAO_TEA_TDAH', () => {
    it('Detecta menção a TEA', async () => {
      const result = processMessageSync('meu filho tem autismo, vocês atendem?');
      expect(result.intent).toBe('INFORMACAO_TEA_TDAH');
    });
    
    it('Detecta menção a TDAH', async () => {
      const result = processMessageSync('preciso de ajuda para TDAH');
      expect(result.intent).toBe('INFORMACAO_TEA_TDAH');
    });
  });
  
  describe('CANCELAMENTO', () => {
    it('Detecta intenção de cancelar', async () => {
      const result = processMessageSync('preciso cancelar minha consulta de amanhã');
      expect(result.intent).toBe('CANCELAMENTO');
    });
  });
  
  describe('REMARCAMENTO', () => {
    it('Detecta intenção de remarcar', async () => {
      const result = processMessageSync('posso adiar meu horário?');
      expect(result.intent).toBe('REMARCAMENTO');
    });
  });
  
  describe('CONFIRMACAO', () => {
    it('Detecta confirmação', async () => {
      const result = processMessageSync('sim, está certo');
      expect(result.intent).toBe('CONFIRMACAO');
    });
  });
  
  describe('RECUSA', () => {
    it('Detecta recusa', async () => {
      const result = processMessageSync('não, de jeito nenhum');
      expect(result.intent).toBe('RECUSA');
    });
  });
  
  describe('AGRADECIMENTO', () => {
    it('Detecta agradecimento', async () => {
      const result = processMessageSync('muito obrigado pela ajuda');
      expect(result.intent).toBe('AGRADECIMENTO');
    });
  });
  
  describe('DESPEDIDA', () => {
    it('Detecta despedida', async () => {
      const result = processMessageSync('tchau, até mais');
      expect(result.intent).toBe('DESPEDIDA');
    });
  });
  
  describe('INFORMACAO', () => {
    it('Detecta informação genérica', async () => {
      const result = processMessageSync('olá, bom dia');
      expect(result.intent).toBe('INFORMACAO');
    });
  });
});

describe('Contract Tests - Fluxos de Conversa', () => {
  
  it('Fluxo completo: primeira mensagem até agendamento', async () => {
    const client = new AmandaTestClient({ mode: 'sync' });
    
    // Mensagem 1: Saudação + problema
    const r1 = await client.sendMessage({
      message: 'oi, meu filho tem dificuldade de fala',
      expectedIntent: 'INFORMACAO'
    });
    expect(r1.intent).toBe('INFORMACAO');
    
    // Mensagem 2: Quer agendar
    const r2 = await client.sendMessage({
      message: 'quero agendar fonoaudiologia',
      expectedIntent: 'AGENDAMENTO'
    });
    expect(r2.intent).toBe('AGENDAMENTO');
    expect(r2.response.toLowerCase()).toContain('nome');
    
    // Mensagem 3: Fornece nome
    const r3 = await client.sendMessage({
      message: 'o nome dele é Pedro Henrique',
      context: { therapyArea: 'fonoaudiologia' }
    });
    
    // Verifica se resposta confirma ou pede idade
    const hasAgeRequest = r3.response.toLowerCase().includes('idade');
    const hasConfirmation = r3.intent === 'CONFIRMACAO' || r3.response.includes('Pedro');
    
    expect(hasAgeRequest || hasConfirmation).toBe(true);
  });
  
  it('Fluxo: pergunta preço -> pergunta convênio -> agendamento', async () => {
    const messages = [
      { msg: 'quanto custa?', expected: 'PERGUNTA_PRECO' },
      { msg: 'e com convênio?', expected: 'PERGUNTA_CONVENIO' },
      { msg: 'quero agendar então', expected: 'AGENDAMENTO' }
    ];
    
    const client = new AmandaTestClient({ mode: 'sync' });
    
    for (const { msg, expected } of messages) {
      const result = await client.sendMessage({
        message: msg,
        expectedIntent: expected
      });
      
      expect(result.intent).toBe(expected);
    }
  });
});
