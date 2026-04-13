// tests/completeSession.dto.test.js
// 🎯 Testes de DTO - Não precisam de banco

import { describe, it, expect } from '@jest/globals';
import { 
  createCompleteSessionResponse, 
  createErrorResponse,
  BILLING_TO_PAYMENT_STATUS 
} from '../dtos/completeSessionResponse.dto.js';

describe('Complete Session DTO', () => {
  describe('createCompleteSessionResponse', () => {
    it('deve criar DTO completo com todos os campos', () => {
      const dto = createCompleteSessionResponse({
        appointmentId: 'test-id-123',
        sessionId: 'session-456',
        packageId: 'package-789',
        clinicalStatus: 'completed',
        operationalStatus: 'completed',
        paymentStatus: 'unpaid',
        balanceAmount: 150,
        sessionValue: 150,
        isPaid: false,
        correlationId: 'corr-test-123'
      });

      // Estrutura base
      expect(dto).toHaveProperty('success', true);
      expect(dto).toHaveProperty('idempotent', false);
      expect(dto).toHaveProperty('message');
      expect(dto).toHaveProperty('data');
      expect(dto).toHaveProperty('meta');

      // Campos de data
      expect(dto.data.appointmentId).toBe('test-id-123');
      expect(dto.data.clinicalStatus).toBe('completed');
      expect(dto.data.operationalStatus).toBe('completed');
      expect(dto.data.paymentStatus).toBe('unpaid');
      expect(dto.data.balanceAmount).toBe(150);
      expect(dto.data.sessionValue).toBe(150);
      expect(dto.data.isPaid).toBe(false);
      expect(dto.data).toHaveProperty('completedAt');

      // Meta
      expect(dto.meta.version).toBe('v2');
      expect(dto.meta.correlationId).toBe('corr-test-123');
      expect(dto.meta).toHaveProperty('timestamp');
    });

    it('deve criar DTO idempotente corretamente', () => {
      const dto = createCompleteSessionResponse({
        appointmentId: 'test-id',
        clinicalStatus: 'completed',
        operationalStatus: 'completed',
        paymentStatus: 'unpaid',
        balanceAmount: 150,
        sessionValue: 150,
        isPaid: false,
        correlationId: 'test-corr',
        idempotent: true
      });

      expect(dto.success).toBe(true);
      expect(dto.idempotent).toBe(true);
      expect(dto.message).toContain('já estava completada');
    });

    it('deve ter tipos corretos', () => {
      const dto = createCompleteSessionResponse({
        appointmentId: 'test',
        balanceAmount: 150.50,
        sessionValue: 150.50,
        isPaid: false,
        correlationId: 'test'
      });

      expect(typeof dto.success).toBe('boolean');
      expect(typeof dto.data.balanceAmount).toBe('number');
      expect(typeof dto.data.sessionValue).toBe('number');
      expect(typeof dto.data.isPaid).toBe('boolean');
      expect(typeof dto.meta.version).toBe('string');
      expect(typeof dto.meta.timestamp).toBe('string');
    });
  });

  describe('createErrorResponse', () => {
    it('deve criar DTO de erro corretamente', () => {
      const errorDto = createErrorResponse({
        code: 'INVALID_STATUS',
        message: 'Cannot complete canceled session'
      });

      expect(errorDto.success).toBe(false);
      expect(errorDto.error.code).toBe('INVALID_STATUS');
      expect(errorDto.error.message).toBe('Cannot complete canceled session');
      expect(errorDto.meta.version).toBe('v2');
      expect(errorDto.meta).toHaveProperty('timestamp');
    });
  });

  describe('BILLING_TO_PAYMENT_STATUS', () => {
    it('deve mapear billing types corretamente', () => {
      expect(BILLING_TO_PAYMENT_STATUS['particular']).toBe('unpaid');
      expect(BILLING_TO_PAYMENT_STATUS['therapy']).toBe('unpaid');
      expect(BILLING_TO_PAYMENT_STATUS['convenio']).toBe('pending_receipt');
      expect(BILLING_TO_PAYMENT_STATUS['liminar']).toBe('paid');
    });
  });

  describe('Regras de Negócio no DTO', () => {
    it('particular deve ter balanceAmount = sessionValue', () => {
      const sessionValue = 200;
      
      const dto = createCompleteSessionResponse({
        appointmentId: 'test',
        paymentStatus: BILLING_TO_PAYMENT_STATUS['particular'],
        balanceAmount: sessionValue,
        sessionValue: sessionValue,
        isPaid: false,
        correlationId: 'test'
      });

      expect(dto.data.balanceAmount).toBe(sessionValue);
      expect(dto.data.isPaid).toBe(false);
      expect(dto.data.paymentStatus).toBe('unpaid');
    });

    it('liminar deve ter isPaid = true', () => {
      const dto = createCompleteSessionResponse({
        appointmentId: 'test',
        paymentStatus: BILLING_TO_PAYMENT_STATUS['liminar'],
        balanceAmount: 0,
        sessionValue: 150,
        isPaid: true,
        correlationId: 'test'
      });

      expect(dto.data.isPaid).toBe(true);
      expect(dto.data.paymentStatus).toBe('paid');
    });

    it('convenio deve ter balanceAmount = 0', () => {
      const dto = createCompleteSessionResponse({
        appointmentId: 'test',
        paymentStatus: BILLING_TO_PAYMENT_STATUS['convenio'],
        balanceAmount: 0,
        sessionValue: 150,
        isPaid: false,
        correlationId: 'test'
      });

      expect(dto.data.balanceAmount).toBe(0);
      expect(dto.data.paymentStatus).toBe('pending_receipt');
    });
  });
});
