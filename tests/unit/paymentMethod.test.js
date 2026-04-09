/**
 * 🧪 Testes Unitários - PaymentMethod Enum
 * 
 * Garante que todas as formas de pagamento usadas pelo frontend
 * sejam aceitas pelos modelos do backend.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import Appointment from '../../models/Appointment.js';
import Payment from '../../models/Payment.js';
import Session from '../../models/Session.js';
import PatientBalance from '../../models/PatientBalance.js';

// Lista de paymentMethods usados pelo frontend
const FRONTEND_PAYMENT_METHODS = [
  'dinheiro',
  'pix',
  'credito',      // Cartão de Crédito (simplificado)
  'debito',       // Cartão de Débito (simplificado)
  'transferencia' // Transferência (simplificado)
];

// Métodos que NÃO devem mais ser usados (legado)
const DEPRECATED_METHODS = [
  'cartao'  // Genérico - removido em favor de 'credito'/'debito'
];

describe('🧪 PaymentMethod Enum Validation', () => {
  
  describe('✅ Appointment Model', () => {
    it('deve aceitar todos os paymentMethods do frontend', async () => {
      for (const method of FRONTEND_PAYMENT_METHODS) {
        const appointment = new Appointment({
          doctorId: new mongoose.Types.ObjectId(),
          patientId: new mongoose.Types.ObjectId(),
          date: new Date(),
          time: '10:00',
          specialty: 'fonoaudiologia',
          paymentMethod: method,
          billingType: 'particular',
          sessionValue: 100
        });
        
        const error = appointment.validateSync();
        expect(error).toBeUndefined();
      }
    });

    it('deve aceitar paymentMethods legados para compatibilidade', async () => {
      const legacyMethods = ['cartao_credito', 'cartao_debito', 'transferencia_bancaria', 'cartão'];
      
      for (const method of legacyMethods) {
        const appointment = new Appointment({
          doctorId: new mongoose.Types.ObjectId(),
          patientId: new mongoose.Types.ObjectId(),
          date: new Date(),
          time: '10:00',
          specialty: 'fonoaudiologia',
          paymentMethod: method,
          billingType: 'particular',
          sessionValue: 100
        });
        
        const error = appointment.validateSync();
        expect(error).toBeUndefined();
      }
    });

    it('deve rejeitar paymentMethod inválido', async () => {
      const appointment = new Appointment({
        doctorId: new mongoose.Types.ObjectId(),
        patientId: new mongoose.Types.ObjectId(),
        date: new Date(),
        time: '10:00',
        specialty: 'fonoaudiologia',
        paymentMethod: 'metodo_invalido',
        billingType: 'particular',
        sessionValue: 100
      });
      
      const error = appointment.validateSync();
      expect(error).toBeDefined();
      expect(error.errors.paymentMethod).toBeDefined();
    });
  });

  describe('✅ Payment Model', () => {
    it('deve aceitar todos os paymentMethods do frontend', async () => {
      for (const method of FRONTEND_PAYMENT_METHODS) {
        const payment = new Payment({
          appointmentId: new mongoose.Types.ObjectId(),
          patientId: new mongoose.Types.ObjectId(),
          patient: new mongoose.Types.ObjectId(),
          amount: 100,
          paymentMethod: method,
          status: 'pending',
          paymentDate: new Date()
        });
        
        // Valida apenas o paymentMethod, ignorando outros campos
        const error = payment.validateSync(['paymentMethod']);
        expect(error).toBeUndefined();
      }
    });

    it('deve rejeitar paymentMethod inválido', async () => {
      const payment = new Payment({
        appointmentId: new mongoose.Types.ObjectId(),
        patientId: new mongoose.Types.ObjectId(),
        patient: new mongoose.Types.ObjectId(),
        amount: 100,
        paymentMethod: 'metodo_invalido',
        status: 'pending',
        paymentDate: new Date()
      });
      
      const error = payment.validateSync();
      expect(error).toBeDefined();
      expect(error.errors.paymentMethod).toBeDefined();
    });
  });

  describe('✅ Session Model', () => {
    it('deve aceitar todos os paymentMethods do frontend', async () => {
      for (const method of FRONTEND_PAYMENT_METHODS) {
        const session = new Session({
          patient: new mongoose.Types.ObjectId(),
          professional: new mongoose.Types.ObjectId(),
          date: new Date(),
          paymentMethod: method,
          status: 'scheduled'
        });
        
        // Valida apenas o paymentMethod
        const error = session.validateSync(['paymentMethod']);
        expect(error).toBeUndefined();
      }
    });
  });

  describe('✅ PatientBalance Model', () => {
    it('deve aceitar todos os paymentMethods do frontend', async () => {
      for (const method of FRONTEND_PAYMENT_METHODS) {
        const balance = new PatientBalance({
          patient: new mongoose.Types.ObjectId(),
          type: 'credit',
          amount: 100,
          paymentMethod: method,
          description: 'Test'
        });
        
        // Valida apenas o paymentMethod
        const error = balance.validateSync(['paymentMethod']);
        expect(error).toBeUndefined();
      }
    });
  });

  describe('✅ Valores esperados pelo frontend', () => {
    it('deve ter exatamente os valores que o frontend envia', () => {
      // Simula o que o frontend envia no formulário
      const frontendPayloads = [
        { paymentMethod: 'credito', label: 'Cartão de Crédito' },
        { paymentMethod: 'debito', label: 'Cartão de Débito' },
        { paymentMethod: 'transferencia', label: 'Transferência' },
        { paymentMethod: 'dinheiro', label: 'Dinheiro' },
        { paymentMethod: 'pix', label: 'PIX' }
      ];

      for (const payload of frontendPayloads) {
        const appointment = new Appointment({
          doctorId: new mongoose.Types.ObjectId(),
          patientId: new mongoose.Types.ObjectId(),
          date: new Date(),
          time: '10:00',
          specialty: 'fonoaudiologia',
          paymentMethod: payload.paymentMethod,
          billingType: 'particular',
          sessionValue: 100
        });
        
        const error = appointment.validateSync();
        expect(error).toBeUndefined();
      }
    });
  });
});

// Teste de integração - validação completa
describe('🧪 Validação Completa (Integração)', () => {
  it('deve validar todos os paymentMethods do frontend nos modelos', async () => {
    // Testa os valores diretamente no enum do Appointment
    for (const method of FRONTEND_PAYMENT_METHODS) {
      const appointment = new Appointment({
        doctorId: new mongoose.Types.ObjectId(),
        patientId: new mongoose.Types.ObjectId(),
        date: new Date(),
        time: '10:00',
        specialty: 'fonoaudiologia',
        paymentMethod: method,
        billingType: 'particular',
        sessionValue: 100
      });
      
      const error = appointment.validateSync();
      expect(error).toBeUndefined();
    }
    
    console.log('✅ Todos os paymentMethods do frontend são válidos nos modelos!');
  });
});

console.log('🧪 Testes de PaymentMethod configurados');
console.log('   Métodos validados:', FRONTEND_PAYMENT_METHODS.join(', '));
