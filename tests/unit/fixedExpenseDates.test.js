import { describe, it, expect } from 'vitest';
import {
    toCompetenceMonth,
    monthBounds,
    computeDueDate,
    isEligibleForMonth
} from '../../utils/fixedExpenseDates.js';

describe('fixedExpenseDates', () => {
    it('toCompetenceMonth zera à esquerda', () => {
        expect(toCompetenceMonth(2026, 9)).toBe('2026-09');
        expect(toCompetenceMonth(2026, 12)).toBe('2026-12');
    });

    it('monthBounds devolve primeiro e último dia', () => {
        expect(monthBounds('2026-09')).toEqual({ start: '2026-09-01', end: '2026-09-30' });
        expect(monthBounds('2026-12')).toEqual({ start: '2026-12-01', end: '2026-12-31' });
    });

    describe('computeDueDate', () => {
        it('dia normal', () => {
            expect(computeDueDate('2026-10', 5)).toBe('2026-10-05');
        });
        it('dia 31 em mês de 30 dias vira o último dia', () => {
            expect(computeDueDate('2026-09', 31)).toBe('2026-09-30');
        });
        it('dia 31 em fevereiro (ano comum e bissexto)', () => {
            expect(computeDueDate('2026-02', 31)).toBe('2026-02-28');
            expect(computeDueDate('2028-02', 30)).toBe('2028-02-29');
        });
        it('dia 31 em mês de 31 dias permanece', () => {
            expect(computeDueDate('2026-10', 31)).toBe('2026-10-31');
        });
    });

    describe('isEligibleForMonth', () => {
        const base = { active: true, dueDay: 10, startDate: '2026-03-15' };

        it('inativo nunca é elegível', () => {
            expect(isEligibleForMonth({ ...base, active: false }, '2026-09')).toBe(false);
        });
        it('vencimento antes do startDate não gera (mesmo mês do início)', () => {
            expect(isEligibleForMonth(base, '2026-03')).toBe(false); // vence 10/03 < 15/03
            expect(isEligibleForMonth(base, '2026-04')).toBe(true);
        });
        it('mês anterior ao início não gera', () => {
            expect(isEligibleForMonth(base, '2026-02')).toBe(false);
        });
        it('respeita endDate inclusive', () => {
            const m = { ...base, endDate: '2026-09-10' };
            expect(isEligibleForMonth(m, '2026-09')).toBe(true);  // vence 10/09 == endDate
            expect(isEligibleForMonth(m, '2026-10')).toBe(false);
        });
        it('endDate nulo = sem fim', () => {
            expect(isEligibleForMonth({ ...base, endDate: null }, '2030-01')).toBe(true);
        });
        it('dia 31 clampado compara com endDate pela data efetiva', () => {
            const m = { ...base, dueDay: 31, endDate: '2026-09-30' };
            expect(isEligibleForMonth(m, '2026-09')).toBe(true); // vence 30/09
        });
    });
});
