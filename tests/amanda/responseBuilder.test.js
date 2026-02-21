/**
 * Testes para ResponseBuilder.js
 * 
 * Testa as funções de resposta automática baseada em flags.
 */

import { describe, it, expect } from 'vitest';
import { canAutoRespond, buildResponseFromFlags, getTherapyInfo } from '../../services/ResponseBuilder.js';

describe('ResponseBuilder', () => {
  
  describe('canAutoRespond()', () => {
    it('deve retornar true quando asksPrice está ativo', () => {
      const flags = { asksPrice: true };
      expect(canAutoRespond(flags)).toBe(true);
    });

    it('deve retornar true quando asksPlans está ativo', () => {
      const flags = { asksPlans: true };
      expect(canAutoRespond(flags)).toBe(true);
    });

    it('deve retornar true quando mentionsReembolso está ativo', () => {
      const flags = { mentionsReembolso: true };
      expect(canAutoRespond(flags)).toBe(true);
    });

    it('deve retornar true quando asksAddress está ativo', () => {
      const flags = { asksAddress: true };
      expect(canAutoRespond(flags)).toBe(true);
    });

    it('deve retornar true quando asksLocation está ativo', () => {
      const flags = { asksLocation: true };
      expect(canAutoRespond(flags)).toBe(true);
    });

    it('deve retornar true quando asksAboutAfterHours está ativo', () => {
      const flags = { asksAboutAfterHours: true };
      expect(canAutoRespond(flags)).toBe(true);
    });

    it('deve retornar false quando nenhuma flag de auto-resposta está ativa', () => {
      const flags = { 
        mentionsChild: true, 
        mentionsAdult: false,
        wantsSchedule: false 
      };
      expect(canAutoRespond(flags)).toBe(false);
    });

    it('deve retornar false quando flags está vazio', () => {
      expect(canAutoRespond({})).toBe(false);
    });
  });

  describe('buildResponseFromFlags()', () => {
    it('deve retornar resposta de preço para avaliação padrão', () => {
      const flags = { asksPrice: true };
      const context = {};
      const response = buildResponseFromFlags(flags, context);
      
      expect(response).toContain('investimento');
      expect(response).toContain('R$');
      expect(response).toContain('💚');
    });

    it('deve retornar preço específico para neuropsicologia', () => {
      const flags = { asksPrice: true };
      const context = { therapyArea: 'neuropsicologia' };
      const response = buildResponseFromFlags(flags, context);
      
      expect(response).toContain('R$ 2.000');
      expect(response).toContain('6x');
    });

    it('deve retornar informações sobre planos de saúde', () => {
      const flags = { asksPlans: true };
      const response = buildResponseFromFlags(flags, {});
      
      expect(response).toContain('reembolso');
      expect(response).toContain('plano');
      expect(response).toContain('💚');
    });

    it('deve retornar informações sobre reembolso quando mentionsReembolso está ativo', () => {
      const flags = { mentionsReembolso: true };
      const response = buildResponseFromFlags(flags, {});
      
      expect(response).toContain('reembolso');
    });

    it('deve retornar endereço quando asksAddress está ativo', () => {
      const flags = { asksAddress: true };
      const response = buildResponseFromFlags(flags, {});
      
      expect(response).toContain('Av. Minas Gerais');
      expect(response).toContain('405');
      expect(response).toContain('Jundiaí');
      expect(response).toContain('💚');
    });

    it('deve retornar endereço quando asksLocation está ativo', () => {
      const flags = { asksLocation: true };
      const response = buildResponseFromFlags(flags, {});
      
      expect(response).toContain('Av. Minas Gerais');
      expect(response).toContain('estacionamento');
    });

    it('deve retornar horários quando asksAboutAfterHours está ativo', () => {
      const flags = { asksAboutAfterHours: true };
      const response = buildResponseFromFlags(flags, {});
      
      expect(response).toContain('Segunda');
      expect(response).toContain('sexta');
      expect(response).toContain('💚');
    });

    it('deve combinar múltiplas respostas quando várias flags estão ativas', () => {
      const flags = { 
        asksPrice: true, 
        asksAddress: true 
      };
      const response = buildResponseFromFlags(flags, {});
      
      expect(response).toContain('investimento');
      expect(response).toContain('Av. Minas Gerais');
      expect(response).toContain('\n\n'); // separação entre parágrafos
    });

    it('deve retornar string vazia quando nenhuma flag relevante está ativa', () => {
      const flags = { mentionsChild: true };
      const response = buildResponseFromFlags(flags, {});
      
      expect(response).toBe('');
    });
  });

  describe('getTherapyInfo()', () => {
    it('deve retornar informações para fonoaudiologia', () => {
      const info = getTherapyInfo('fonoaudiologia');
      
      expect(info).not.toBeNull();
      expect(info.nome).toBeDefined();
      expect(info.trata).toBeDefined();
      expect(info.idades).toBeDefined();
    });

    it('deve retornar informações para psicologia', () => {
      const info = getTherapyInfo('psicologia');
      
      expect(info).not.toBeNull();
      expect(info.nome).toBeDefined();
    });

    it('deve retornar null para terapia inexistente', () => {
      const info = getTherapyInfo('terapia_inexistente');
      
      expect(info).toBeNull();
    });

    it('deve limitar a lista de tratamentos a 3 itens', () => {
      const info = getTherapyInfo('fonoaudiologia');
      const tratamentos = info.trata.split(', ');
      
      expect(tratamentos.length).toBeLessThanOrEqual(3);
    });
  });
});
