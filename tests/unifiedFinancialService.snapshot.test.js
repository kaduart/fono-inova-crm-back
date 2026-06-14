/**
 * ============================================================================
 * SNAPSHOT TESTS — UnifiedFinancialService V2
 * ============================================================================
 *
 * Valida que os números financeiros de Maio/2026 permanecem estáveis
 * após refatorações. Se este teste quebrar, a regra financeira mudou.
 *
 * Execute: npx jest tests/unifiedFinancialService.snapshot.test.js
 * ============================================================================
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import mongoose from 'mongoose';
import moment from 'moment-timezone';
import unifiedFinancialService from '../services/unifiedFinancialService.v2.js';

const TIMEZONE = 'America/Sao_Paulo';

// ── Ajuste se necessário ──
const TARGET_YEAR  = 2026;
const TARGET_MONTH = 5;

// ── Snapshots verificados manualmente no BD ──
const SNAPSHOT = {
    caixa: {
        total: 35940.8,
        particular: 14070,
        pacote: 17820.8,
        convenio: 0,
        liminar: 4050,
    },
    producao: {
        total: 36140.2,
        particular: 8550,
        pacote: 18750.2,
        convenio: 4790,
        liminar: 4050,
    }
};

describe('UnifiedFinancialService — Snapshot Maio/2026', () => {
    let start, end;

    beforeAll(async () => {
        const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
        if (!uri) throw new Error('MONGODB_URI não configurado');
        await mongoose.connect(uri);

        const mStart = moment.tz([TARGET_YEAR, TARGET_MONTH - 1, 1], TIMEZONE).startOf('day');
        const mEnd   = moment.tz([TARGET_YEAR, TARGET_MONTH - 1, 1], TIMEZONE).endOf('month').endOf('day');
        start = mStart.clone().utc().toDate();
        end   = mEnd.clone().utc().toDate();
    });

    afterAll(async () => {
        await mongoose.disconnect();
    });

    // ═══════════════════════════════════════════════════════════
    // CAIXA
    // ═══════════════════════════════════════════════════════════
    it('caixa.total deve bater com snapshot', async () => {
        const cash = await unifiedFinancialService.calculateCash(start, end);
        expect(cash.total).toBe(SNAPSHOT.caixa.total);
    });

    it('caixa.particular deve bater com snapshot', async () => {
        const cash = await unifiedFinancialService.calculateCash(start, end);
        expect(cash.particular).toBe(SNAPSHOT.caixa.particular);
    });

    it('caixa.pacote deve bater com snapshot', async () => {
        const cash = await unifiedFinancialService.calculateCash(start, end);
        expect(cash.pacote).toBe(SNAPSHOT.caixa.pacote);
    });

    it('caixa.convenio deve bater com snapshot', async () => {
        const cash = await unifiedFinancialService.calculateCash(start, end);
        expect(cash.convenio).toBe(SNAPSHOT.caixa.convenio);
    });

    it('caixa.liminar deve bater com snapshot', async () => {
        const cash = await unifiedFinancialService.calculateCash(start, end);
        expect(cash.liminar).toBe(SNAPSHOT.caixa.liminar);
    });

    it('caixa: particular + pacote + convenio + liminar == total', async () => {
        const cash = await unifiedFinancialService.calculateCash(start, end);
        const sum = cash.particular + cash.pacote + cash.convenio + cash.liminar;
        expect(sum).toBe(cash.total);
    });

    // ═══════════════════════════════════════════════════════════
    // PRODUÇÃO
    // ═══════════════════════════════════════════════════════════
    it('producao.total deve bater com snapshot', async () => {
        const prod = await unifiedFinancialService.calculateProduction(start, end);
        expect(prod.total).toBe(SNAPSHOT.producao.total);
    });

    it('producao.particular deve bater com snapshot', async () => {
        const prod = await unifiedFinancialService.calculateProduction(start, end);
        expect(prod.particular).toBe(SNAPSHOT.producao.particular);
    });

    it('producao.pacote deve bater com snapshot', async () => {
        const prod = await unifiedFinancialService.calculateProduction(start, end);
        expect(prod.pacote).toBe(SNAPSHOT.producao.pacote);
    });

    it('producao.convenio deve bater com snapshot', async () => {
        const prod = await unifiedFinancialService.calculateProduction(start, end);
        expect(prod.convenio).toBe(SNAPSHOT.producao.convenio);
    });

    it('producao.liminar deve bater com snapshot', async () => {
        const prod = await unifiedFinancialService.calculateProduction(start, end);
        expect(prod.liminar).toBe(SNAPSHOT.producao.liminar);
    });

    it('producao: particular + pacote + convenio + liminar == total', async () => {
        const prod = await unifiedFinancialService.calculateProduction(start, end);
        const sum = prod.particular + prod.pacote + prod.convenio + prod.liminar;
        expect(sum).toBe(prod.total);
    });

    it('producao: recebido + pendente == total', async () => {
        const prod = await unifiedFinancialService.calculateProduction(start, end);
        expect(prod.recebido + prod.pendente).toBe(prod.total);
    });

    // ═══════════════════════════════════════════════════════════
    // CONSISTÊNCIA DIÁRIA
    // ═══════════════════════════════════════════════════════════
    it('caixa diário somado == caixa mensal', async () => {
        const cash = await unifiedFinancialService.calculateCash(start, end);
        const byDay = await unifiedFinancialService.calculateCashByDay(start, end);
        const sum = Array.from(byDay.values()).reduce((s, d) => s + d.caixa, 0);
        expect(sum).toBe(cash.total);
    });

    it('producao diária somada == producao mensal', async () => {
        const prod = await unifiedFinancialService.calculateProduction(start, end);
        const byDay = await unifiedFinancialService.calculateProductionByDay(start, end);
        const sum = Array.from(byDay.map.values()).reduce((s, d) => s + d.producao, 0);
        expect(sum).toBe(prod.total);
    });

    // ═══════════════════════════════════════════════════════════
    // REGRAS DE NEGÓCIO
    // ═══════════════════════════════════════════════════════════
    it('caixa >= 0', async () => {
        const cash = await unifiedFinancialService.calculateCash(start, end);
        expect(cash.total).toBeGreaterThanOrEqual(0);
    });

    it('producao >= 0', async () => {
        const prod = await unifiedFinancialService.calculateProduction(start, end);
        expect(prod.total).toBeGreaterThanOrEqual(0);
    });

    it('caixa nunca é maior que produção + pacotes pré-pagos de meses anteriores', async () => {
        // Regra de sanidade: caixa anormalmente maior que produção pode indicar
        // double-count ou pacote pré-pago sendo contado como caixa + consumo
        const cash = await unifiedFinancialService.calculateCash(start, end);
        const prod = await unifiedFinancialService.calculateProduction(start, end);
        const tolerancia = 5000; // permite pacotes pré-pagos de meses anteriores
        expect(cash.total).toBeLessThanOrEqual(prod.total + tolerancia);
    });
});
