import { test, expect } from 'vitest';
import { monthStatus } from '../planningAnnual.js';

test('mês futuro sem realizado', () => {
  expect(monthStatus({ meta: 1000, realizado: null, isFuture: true })).toBe('futuro');
  expect(monthStatus({ meta: 0, realizado: null, isFuture: true })).toBe('sem_meta');
});

test('mês fechado bate ou não bate a meta', () => {
  expect(monthStatus({ meta: 1000, realizado: 1000, isFuture: false, isCurrent: false })).toBe('batida');
  expect(monthStatus({ meta: 1000, realizado: 999, isFuture: false, isCurrent: false })).toBe('nao_batida');
  expect(monthStatus({ meta: 0, realizado: 500, isFuture: false, isCurrent: false })).toBe('sem_meta');
});

test('mês corrente compara com o ritmo esperado', () => {
  expect(monthStatus({ meta: 1000, realizado: 600, isFuture: false, isCurrent: true, percentualEsperado: 50 })).toBe('no_ritmo');
  expect(monthStatus({ meta: 1000, realizado: 400, isFuture: false, isCurrent: true, percentualEsperado: 50 })).toBe('abaixo_do_ritmo');
});
