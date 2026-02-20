// tests/convenioMetrics.test.js
// Testes unitários para ConvenioMetricsService

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import ConvenioMetricsService from '../services/financial/ConvenioMetricsService.js';
import Session from '../models/Session.js';
import Package from '../models/Package.js';
import InsuranceGuide from '../models/InsuranceGuide.js';
import Patient from '../models/Patient.js';
import Doctor from '../models/Doctor.js';

describe('ConvenioMetricsService', () => {
  // Dados de teste
  const testPatientId = new mongoose.Types.ObjectId();
  const testDoctorId = new mongoose.Types.ObjectId();
  const testPackageId = new mongoose.Types.ObjectId();
  const testGuideId = new mongoose.Types.ObjectId();

  beforeAll(async () => {
    // Conectar ao banco de teste
    await mongoose.connect(process.env.MONGO_URI_TEST || 'mongodb://localhost:27017/test_convenio');
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    // Limpar dados antes de cada teste
    await Session.deleteMany({});
    await Package.deleteMany({});
    await InsuranceGuide.deleteMany({});
  });

  describe('getConvenioMetrics', () => {
    it('deve retornar métricas vazias quando não há sessões', async () => {
      const result = await ConvenioMetricsService.getConvenioMetrics({
        month: 2,
        year: 2026
      });

      expect(result).toHaveProperty('period');
      expect(result).toHaveProperty('receitaRealizada');
      expect(result).toHaveProperty('aReceber');
      expect(result).toHaveProperty('provisaoConvenio');
      expect(result.receitaRealizada.total).toBe(0);
      expect(result.receitaRealizada.quantidadeSessoes).toBe(0);
    });

    it('deve calcular receita realizada corretamente', async () => {
      // Criar sessões de teste
      await Session.create([
        {
          _id: new mongoose.Types.ObjectId(),
          patient: testPatientId,
          doctor: testDoctorId,
          date: '2026-02-10',
          time: '10:00',
          status: 'completed',
          paymentMethod: 'convenio',
          sessionValue: 180,
          package: testPackageId,
          insuranceGuide: testGuideId
        },
        {
          _id: new mongoose.Types.ObjectId(),
          patient: testPatientId,
          doctor: testDoctorId,
          date: '2026-02-15',
          time: '14:00',
          status: 'completed',
          paymentMethod: 'convenio',
          sessionValue: 180,
          package: testPackageId,
          insuranceGuide: testGuideId
        }
      ]);

      const result = await ConvenioMetricsService.getConvenioMetrics({
        month: 2,
        year: 2026
      });

      expect(result.receitaRealizada.total).toBe(360);
      expect(result.receitaRealizada.quantidadeSessoes).toBe(2);
    });

    it('deve calcular provisão acumulada até o mês pesquisado', async () => {
      // Sessões em meses diferentes
      await Session.create([
        {
          patient: testPatientId,
          doctor: testDoctorId,
          date: '2026-01-15', // Janeiro
          time: '10:00',
          status: 'completed',
          paymentMethod: 'convenio',
          sessionValue: 180,
          isPaid: false
        },
        {
          patient: testPatientId,
          doctor: testDoctorId,
          date: '2026-02-10', // Fevereiro
          time: '10:00',
          status: 'completed',
          paymentMethod: 'convenio',
          sessionValue: 180,
          isPaid: false
        }
      ]);

      const result = await ConvenioMetricsService.getConvenioMetrics({
        month: 2,
        year: 2026
      });

      // Provisão deve incluir janeiro + fevereiro
      expect(result.provisaoConvenio.total).toBe(360);
      expect(result.provisaoConvenio.quantidadeSessoes).toBe(2);
    });

    it('deve separar sessões agendadas futuras', async () => {
      await Session.create([
        {
          patient: testPatientId,
          doctor: testDoctorId,
          date: '2026-03-10', // Março (futuro)
          time: '10:00',
          status: 'scheduled',
          paymentMethod: 'convenio',
          sessionValue: 180
        },
        {
          patient: testPatientId,
          doctor: testDoctorId,
          date: '2026-04-15', // Abril (futuro)
          time: '10:00',
          status: 'scheduled',
          paymentMethod: 'convenio',
          sessionValue: 180
        }
      ]);

      const result = await ConvenioMetricsService.getConvenioMetrics({
        month: 2,
        year: 2026
      });

      // Pipeline futuro deve ter as sessões agendadas
      expect(result.pipelineFuturo.total).toBe(360);
      expect(result.pipelineFuturo.quantidadeSessoes).toBe(2);
    });
  });

  describe('getDashboardSummary', () => {
    it('deve retornar cards formatados corretamente', async () => {
      const result = await ConvenioMetricsService.getDashboardSummary();

      expect(result).toHaveProperty('cards');
      expect(result).toHaveProperty('alertas');
      expect(result.cards).toHaveProperty('producaoMes');
      expect(result.cards).toHaveProperty('aReceber');
      expect(result.cards).toHaveProperty('pipeline');
    });
  });

  describe('Cálculos de provisão', () => {
    it('não deve incluir sessões já pagas na provisão', async () => {
      await Session.create([
        {
          patient: testPatientId,
          doctor: testDoctorId,
          date: '2026-02-10',
          time: '10:00',
          status: 'completed',
          paymentMethod: 'convenio',
          sessionValue: 180,
          isPaid: true // Já pago
        },
        {
          patient: testPatientId,
          doctor: testDoctorId,
          date: '2026-02-15',
          time: '10:00',
          status: 'completed',
          paymentMethod: 'convenio',
          sessionValue: 180,
          isPaid: false // Não pago
        }
      ]);

      const result = await ConvenioMetricsService.getConvenioMetrics({
        month: 2,
        year: 2026
      });

      // Só deve contar a sessão não paga
      expect(result.provisaoConvenio.quantidadeSessoes).toBe(1);
      expect(result.provisaoConvenio.total).toBe(180);
    });

    it('deve calcular corretamente quando há múltiplos convênios', async () => {
      await Session.create([
        {
          patient: testPatientId,
          doctor: testDoctorId,
          date: '2026-02-10',
          time: '10:00',
          status: 'completed',
          paymentMethod: 'convenio',
          sessionValue: 200,
          package: new mongoose.Types.ObjectId()
        },
        {
          patient: testPatientId,
          doctor: testDoctorId,
          date: '2026-02-11',
          time: '10:00',
          status: 'completed',
          paymentMethod: 'convenio',
          sessionValue: 150,
          package: new mongoose.Types.ObjectId()
        }
      ]);

      const result = await ConvenioMetricsService.getConvenioMetrics({
        month: 2,
        year: 2026
      });

      expect(result.receitaRealizada.total).toBe(350);
      expect(result.receitaRealizada.quantidadeSessoes).toBe(2);
    });
  });
});
