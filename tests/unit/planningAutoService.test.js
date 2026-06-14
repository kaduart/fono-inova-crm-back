/**
 * Testes unitários para planningAutoService.js
 * Automação de planejamentos mensal → semanal → diário.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import Planning from '../../models/Planning.js';
import {
  generateMonthlyCascade,
  recalculateFutureTargets,
  getMonthWorkingDays,
  getWeeksOfMonth
} from '../../services/planningAutoService.js';

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

const createUserId = () => new mongoose.Types.ObjectId();

describe('planningAutoService', () => {
  beforeEach(async () => {
    await Planning.deleteMany({});
  });

  describe('getMonthWorkingDays', () => {
    it('junho/2026 deve ter 22 dias úteis (seg–sex, sem feriados)', () => {
      const days = getMonthWorkingDays(2026, 6);
      expect(days.length).toBe(21); // Corpus Christi 04/06/2026 é feriado
      expect(days[0]).toBe('2026-06-01');
      expect(days[days.length - 1]).toBe('2026-06-30');
      // Nenhum sábado ou domingo
      days.forEach(d => {
        const date = new Date(d + 'T00:00:00');
        const weekday = date.getDay();
        expect(weekday).toBeGreaterThanOrEqual(1);
        expect(weekday).toBeLessThanOrEqual(5);
      });
    });

    it('setembro/2026 deve excluir feriado 07/09', () => {
      const days = getMonthWorkingDays(2026, 9);
      expect(days).not.toContain('2026-09-07');
    });
  });

  describe('getWeeksOfMonth', () => {
    it('deve retornar 4 semanas fixas', () => {
      const weeks = getWeeksOfMonth(2026, 6);
      expect(weeks).toHaveLength(4);
      expect(weeks[0]).toEqual({ start: '2026-06-01', end: '2026-06-07' });
      expect(weeks[3]).toEqual({ start: '2026-06-22', end: '2026-06-30' });
    });
  });

  describe('generateMonthlyCascade', () => {
    it('deve criar mensal + 4 semanais + 22 diários para junho/2026', async () => {
      const userId = createUserId();
      const result = await generateMonthlyCascade(6, 2026, {
        expectedRevenue: 50000,
        totalSessions: 200,
        workHours: 134,
        averageTicket: 250,
        commercialTicket: 1500
      }, userId);

      expect(result.monthly.type).toBe('monthly');
      expect(result.monthly.targets.expectedRevenue).toBe(50000);
      expect(result.weekly).toHaveLength(4);
      expect(result.daily).toHaveLength(21);

      const totalDailyRevenue = result.daily.reduce((s, d) => s + d.targets.expectedRevenue, 0);
      const totalWeeklyRevenue = result.weekly.reduce((s, w) => s + w.targets.expectedRevenue, 0);

      expect(totalDailyRevenue).toBeCloseTo(50000, 2);
      expect(totalWeeklyRevenue).toBeCloseTo(50000, 2);
    });

    it('deve recriar semanais/diários ao chamar novamente (idempotente)', async () => {
      const userId = createUserId();
      await generateMonthlyCascade(6, 2026, {
        expectedRevenue: 50000,
        totalSessions: 200,
        workHours: 134,
        averageTicket: 250,
        commercialTicket: 1500
      }, userId);

      await generateMonthlyCascade(6, 2026, {
        expectedRevenue: 60000,
        totalSessions: 240,
        workHours: 160,
        averageTicket: 250,
        commercialTicket: 1500
      }, userId);

      const all = await Planning.find({ type: { $in: ['weekly', 'daily'] }, 'period.start': { $gte: '2026-06-01', $lte: '2026-06-30' } });
      const dailies = all.filter(p => p.type === 'daily');
      const weeklies = all.filter(p => p.type === 'weekly');
      expect(dailies).toHaveLength(21);
      expect(weeklies).toHaveLength(4);

      const totalDailyRevenue = dailies.reduce((s, d) => s + d.targets.expectedRevenue, 0);
      expect(totalDailyRevenue).toBeCloseTo(60000, 2);
    });

    it('deve preservar o planejamento mensal e atualizar seus targets', async () => {
      const userId = createUserId();
      const first = await generateMonthlyCascade(6, 2026, {
        expectedRevenue: 50000,
        totalSessions: 200,
        workHours: 134,
        averageTicket: 250,
        commercialTicket: 1500
      }, userId);

      const second = await generateMonthlyCascade(6, 2026, {
        expectedRevenue: 60000,
        totalSessions: 240,
        workHours: 160,
        averageTicket: 250,
        commercialTicket: 1500
      }, userId);

      expect(first.monthly._id.toString()).toBe(second.monthly._id.toString());
      expect(second.monthly.targets.expectedRevenue).toBe(60000);
    });
  });

  describe('recalculateFutureTargets', () => {
    it('deve redistribuir metas futuras com base no gap realizado', async () => {
      const userId = createUserId();
      await generateMonthlyCascade(6, 2026, {
        expectedRevenue: 50000,
        totalSessions: 200,
        workHours: 134,
        averageTicket: 250,
        commercialTicket: 1500
      }, userId);

      // Simular que já passaram os primeiros 10 dias úteis e realizamos R$ 10.000
      const dailies = await Planning.find({ type: 'daily', 'period.start': { $gte: '2026-06-01', $lte: '2026-06-30' } }).sort({ 'period.start': 1 });
      const pastCount = 10;
      for (let i = 0; i < pastCount; i++) {
        dailies[i].actual.actualRevenue = 1000;
        await dailies[i].save();
      }

      // Mockar hoje para depois do 10º dia útil
      const tenthWorkingDay = dailies[pastCount - 1].period.start;
      const mockToday = new Date(tenthWorkingDay + 'T00:00:00-03:00');
      mockToday.setDate(mockToday.getDate() + 1);
      vi.setSystemTime(mockToday);

      const result = await recalculateFutureTargets(6, 2026);

      vi.useRealTimers();

      expect(result.updated.length).toBe(21 - pastCount);
      const futureSum = result.updated.reduce((s, d) => s + d.targets.expectedRevenue, 0);
      expect(futureSum).toBeCloseTo(40000, 2); // 50000 - 10000
    });

    it('deve lançar erro se não houver planejamento mensal', async () => {
      await expect(recalculateFutureTargets(6, 2026)).rejects.toThrow('Planejamento mensal não encontrado');
    });
  });
});
