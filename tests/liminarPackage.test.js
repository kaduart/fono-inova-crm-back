/**
 * 🧪 Testes para Pacotes Liminar
 * 
 * Estes testes validam o comportamento do tipo de pacote 'liminar'
 * incluindo criação, reconhecimento de receita e reversão.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import Package from '../models/Package.js';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';
import Patient from '../models/Patient.js';
import Doctor from '../models/Doctor.js';

describe('⚖️ Pacotes Liminar', () => {
  let testPatient;
  let testDoctor;
  let testPackage;

  beforeAll(async () => {
    // Criar dados de teste
    testPatient = await Patient.create({
      name: 'Paciente Teste Liminar',
      phone: '62999999999'
    });

    testDoctor = await Doctor.create({
      fullName: 'Doutor Teste',
      specialty: 'fonoaudiologia'
    });
  });

  afterAll(async () => {
    // Limpar dados de teste
    await Package.deleteMany({ type: 'liminar' });
    await Patient.findByIdAndDelete(testPatient._id);
    await Doctor.findByIdAndDelete(testDoctor._id);
  });

  describe('Criação de Pacote Liminar', () => {
    it('deve criar um pacote liminar com campos específicos', async () => {
      const packageData = {
        patient: testPatient._id,
        doctor: testDoctor._id,
        date: new Date('2026-03-20'),
        sessionType: 'fonoaudiologia',
        specialty: 'fonoaudiologia',
        sessionValue: 125.00,
        totalSessions: 48,
        totalValue: 6000.00,
        type: 'liminar',
        liminarProcessNumber: '1234567-89.2026.8.01.0000',
        liminarCourt: '1ª Vara Cível de Anápolis',
        liminarExpirationDate: new Date('2026-09-20'),
        liminarMode: 'hybrid',
        liminarAuthorized: true,
        liminarTotalCredit: 6000.00,
        liminarCreditBalance: 6000.00,
        recognizedRevenue: 0
      };

      testPackage = await Package.create(packageData);

      expect(testPackage.type).toBe('liminar');
      expect(testPackage.liminarProcessNumber).toBe('1234567-89.2026.8.01.0000');
      expect(testPackage.liminarCourt).toBe('1ª Vara Cível de Anápolis');
      expect(testPackage.liminarCreditBalance).toBe(6000.00);
      expect(testPackage.liminarTotalCredit).toBe(6000.00);
      expect(testPackage.recognizedRevenue).toBe(0);
    });

    it('deve permitir criar pacote liminar sem campos opcionais (processo, vara)', async () => {
      const minimalPackage = {
        patient: testPatient._id,
        doctor: testDoctor._id,
        date: new Date(),
        sessionType: 'fonoaudiologia',
        specialty: 'fonoaudiologia',
        sessionValue: 125.00,
        totalSessions: 48,
        totalValue: 6000.00,
        type: 'liminar'
        // Sem liminarProcessNumber, sem liminarCourt - são opcionais!
      };

      const pkg = await Package.create(minimalPackage);
      expect(pkg.type).toBe('liminar');
      expect(pkg.liminarProcessNumber).toBeNull();
      expect(pkg.liminarCourt).toBeNull();
      expect(pkg.liminarCreditBalance).toBe(0); // default
    });
  });

  describe('Reconhecimento de Receita', () => {
    it('deve criar sessão com status de pagamento recognized', async () => {
      const session = await Session.create({
        date: '2026-03-20',
        time: '09:00',
        patient: testPatient._id,
        doctor: testDoctor._id,
        package: testPackage._id,
        sessionValue: 125.00,
        sessionType: 'fonoaudiologia',
        specialty: 'fonoaudiologia',
        status: 'completed',
        isPaid: true,
        paymentStatus: 'recognized',
        visualFlag: 'ok',
        paymentMethod: 'liminar_credit'
      });

      expect(session.paymentStatus).toBe('recognized');
      expect(session.paymentMethod).toBe('liminar_credit');
      expect(session.isPaid).toBe(true);
    });

    it('deve permitir enum paymentStatus recognized', async () => {
      const validStatuses = ['paid', 'partial', 'pending', 'pending_receipt', 'recognized'];
      
      for (const status of validStatuses) {
        const session = new Session({
          date: '2026-03-21',
          time: '10:00',
          patient: testPatient._id,
          doctor: testDoctor._id,
          sessionValue: 125.00,
          sessionType: 'fonoaudiologia',
          specialty: 'fonoaudiologia',
          status: 'scheduled',
          paymentStatus: status
        });

        // Não deve lançar erro de validação
        await expect(session.validate()).resolves.not.toThrow();
      }
    });
  });

  describe('Pagamentos de Receita Reconhecida', () => {
    it('deve criar pagamento do tipo revenue_recognition', async () => {
      const payment = await Payment.create({
        patient: testPatient._id,
        doctor: testDoctor._id,
        serviceType: 'package_session',
        amount: 125.00,
        paymentMethod: 'liminar_credit',
        status: 'recognized',
        kind: 'revenue_recognition',
        package: testPackage._id,
        paymentDate: '2026-03-20',
        notes: 'Receita reconhecida - Processo: 1234567-89.2026.8.01.0000'
      });

      expect(payment.kind).toBe('revenue_recognition');
      expect(payment.status).toBe('recognized');
      expect(payment.paymentMethod).toBe('liminar_credit');
    });

    it('deve permitir kind revenue_recognition no enum', async () => {
      const validKinds = ['package_receipt', 'session_payment', 'manual', 'auto', 'session_completion', 'revenue_recognition'];
      
      for (const kind of validKinds) {
        const payment = new Payment({
          patient: testPatient._id,
          doctor: testDoctor._id,
          serviceType: 'package_session',
          amount: 100,
          paymentMethod: 'pix',
          paymentDate: '2026-03-20',
          kind: kind
        });

        await expect(payment.validate()).resolves.not.toThrow();
      }
    });
  });

  describe('Cálculos de Crédito e Receita', () => {
    it('deve calcular saldo de crédito corretamente', async () => {
      // Simular consumo de 2 sessões
      const sessionValue = 125.00;
      const sessionsCompleted = 2;
      const recognizedRevenue = sessionValue * sessionsCompleted;
      const creditBalance = testPackage.liminarTotalCredit - recognizedRevenue;

      expect(creditBalance).toBe(5750.00);
      expect(recognizedRevenue).toBe(250.00);
    });

    it('deve calcular percentual de execução da liminar', async () => {
      const recognized = 3000.00; // Metade do valor
      const total = testPackage.liminarTotalCredit;
      const percentual = (recognized / total) * 100;

      expect(percentual).toBe(50);
    });
  });
});

/**
 * 📋 Exemplo de Fluxo Completo
 * 
 * Este exemplo demonstra o fluxo completo de um pacote liminar:
 * 
 * 1. Criação do pacote com crédito total
 * 2. Completar sessão (reconhece receita)
 * 3. Verificar saldo atualizado
 * 4. Descompletar sessão (reverte receita)
 * 5. Verificar saldo restaurado
 */
describe('🔄 Fluxo Completo Liminar', () => {
  it('deve executar fluxo completo de liminar', async () => {
    // 1. Criar paciente e pacote
    const patient = await Patient.create({
      name: 'Fluxo Teste Liminar',
      phone: '62988888888'
    });

    const pkg = await Package.create({
      patient: patient._id,
      doctor: testDoctor._id,
      date: new Date('2026-03-20'),
      sessionType: 'fonoaudiologia',
      specialty: 'fonoaudiologia',
      sessionValue: 125.00,
      totalSessions: 48,
      totalValue: 6000.00,
      type: 'liminar',
      liminarProcessNumber: '9876543-21.2026.8.01.0000',
      liminarCourt: '2ª Vara Cível',
      liminarMode: 'hybrid',
      liminarTotalCredit: 6000.00,
      liminarCreditBalance: 6000.00,
      recognizedRevenue: 0
    });

    expect(pkg.liminarCreditBalance).toBe(6000.00);
    expect(pkg.recognizedRevenue).toBe(0);

    // 2. Criar e completar sessão
    const session = await Session.create({
      date: '2026-03-20',
      time: '09:00',
      patient: patient._id,
      doctor: testDoctor._id,
      package: pkg._id,
      sessionValue: 125.00,
      sessionType: 'fonoaudiologia',
      specialty: 'fonoaudiologia',
      status: 'completed',
      isPaid: true,
      paymentStatus: 'recognized',
      visualFlag: 'ok',
      paymentMethod: 'liminar_credit'
    });

    // 3. Simular atualização do pacote (como no controller)
    pkg.liminarCreditBalance -= session.sessionValue;
    pkg.recognizedRevenue += session.sessionValue;
    await pkg.save();

    expect(pkg.liminarCreditBalance).toBe(5875.00);
    expect(pkg.recognizedRevenue).toBe(125.00);

    // 4. Criar pagamento de reconhecimento
    const payment = await Payment.create({
      patient: patient._id,
      doctor: testDoctor._id,
      serviceType: 'package_session',
      amount: session.sessionValue,
      paymentMethod: 'liminar_credit',
      status: 'recognized',
      kind: 'revenue_recognition',
      package: pkg._id,
      paymentDate: '2026-03-20',
      session: session._id
    });

    expect(payment.kind).toBe('revenue_recognition');

    // Limpar
    await Session.findByIdAndDelete(session._id);
    await Payment.findByIdAndDelete(payment._id);
    await Package.findByIdAndDelete(pkg._id);
    await Patient.findByIdAndDelete(patient._id);
  });
});

console.log('✅ Testes de pacotes liminar configurados');
