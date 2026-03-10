/**
 * Testes de regressão — StateMachine.js
 *
 * BUGS COBERTOS:
 *  [BUG-3] retryCount undefined — incrementRetry não retornava campo "retryCount"
 *  [BUG-4] isAutoResume não cobria COLLECT_THERAPY → INTERRUPTED não retomava
 *  [FEAT]  COLLECT_NEURO_TYPE adicionado ao STATES, RESUME_HINTS, isAutoResume
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─────────────────────────────────────────────────────────────
// Mock do Leads (incrementRetry usa Leads.findByIdAndUpdate)
// ─────────────────────────────────────────────────────────────
const mockFindByIdAndUpdate = vi.fn();

vi.mock('../../models/Leads.js', () => ({
    default: {
        findByIdAndUpdate: (...args) => mockFindByIdAndUpdate(...args),
    },
}));

// Mock dos helpers que o StateMachine importa
vi.mock('../../helpers/intentHelper.js', () => ({
    isSideIntent: vi.fn(),
    normalizeIntent: vi.fn(),
    INTENT_TYPES: {},
}));
vi.mock('../../helpers/flowStateHelper.js', () => ({
    buildResumptionMessage: vi.fn(),
    detectTopicShift: vi.fn(),
}));
vi.mock('../../helpers/missingFieldsHelper.js', () => ({
    AWAITING_FIELDS: {},
}));

import {
    STATES,
    detectGlobalIntent,
    getResumeHint,
    isAutoResume,
    incrementRetry,
} from '../../services/StateMachine.js';

// ═══════════════════════════════════════════════════════════════
// STATES — novo estado COLLECT_NEURO_TYPE
// ═══════════════════════════════════════════════════════════════
describe('STATES — COLLECT_NEURO_TYPE adicionado', () => {
    it('COLLECT_NEURO_TYPE existe no enum STATES', () => {
        expect(STATES.COLLECT_NEURO_TYPE).toBe('COLLECT_NEURO_TYPE');
    });

    it('todos os estados esperados existem', () => {
        const expected = [
            'IDLE', 'GREETING', 'COLLECT_THERAPY', 'COLLECT_NEURO_TYPE',
            'COLLECT_NAME', 'COLLECT_BIRTH', 'COLLECT_COMPLAINT',
            'COLLECT_PERIOD', 'SHOW_SLOTS', 'CONFIRM_BOOKING',
            'BOOKED', 'INTERRUPTED', 'HANDOFF',
        ];
        for (const s of expected) {
            expect(STATES[s], `STATES.${s} deve existir`).toBeDefined();
        }
    });
});

// ═══════════════════════════════════════════════════════════════
// [BUG-3] incrementRetry — retryCount era undefined
// ═══════════════════════════════════════════════════════════════
describe('[BUG-3] incrementRetry — retryCount definido', () => {
    beforeEach(() => {
        mockFindByIdAndUpdate.mockReset();
    });

    it('retorna retryCount (não apenas count) quando não atingiu MAX_RETRIES', async () => {
        mockFindByIdAndUpdate.mockResolvedValue({ retryCount: 1 });

        const result = await incrementRetry('lead-abc');

        expect(result.retryCount, 'retryCount não deve ser undefined').toBeDefined();
        expect(result.retryCount).toBe(1);
        expect(result.count).toBe(1); // campo legado também mantido
        expect(result.handoff).toBe(false);
    });

    it('retorna retryCount quando atinge MAX_RETRIES (handoff=true)', async () => {
        // MAX_RETRIES = 3
        mockFindByIdAndUpdate
            .mockResolvedValueOnce({ retryCount: 3 })  // primeira chamada: findByIdAndUpdate com $inc
            .mockResolvedValueOnce({ retryCount: 0 }); // segunda chamada: reset para HANDOFF

        const result = await incrementRetry('lead-abc');

        expect(result.retryCount, 'retryCount não deve ser undefined no handoff').toBeDefined();
        expect(result.handoff).toBe(true);
    });

    it('destrói retryCount=undefined quando destructuring "const { handoff, retryCount }"', async () => {
        mockFindByIdAndUpdate.mockResolvedValue({ retryCount: 2 });

        const { handoff, retryCount } = await incrementRetry('lead-test');

        // Esse era o bug: retryCount vinha undefined porque a função retornava { count, handoff }
        expect(retryCount).not.toBeUndefined();
        expect(typeof retryCount).toBe('number');
    });
});

// ═══════════════════════════════════════════════════════════════
// [BUG-4] isAutoResume — COLLECT_THERAPY não coberto
// ═══════════════════════════════════════════════════════════════
describe('[BUG-4] isAutoResume — COLLECT_THERAPY retomada automática', () => {
    it('retorna true para "Neuropsicologia" quando suspenso em COLLECT_THERAPY', () => {
        expect(isAutoResume('Neuropsicologia', STATES.COLLECT_THERAPY)).toBe(true);
    });

    it('retorna true para "neuropsicologia" (minúsculas)', () => {
        expect(isAutoResume('neuropsicologia', STATES.COLLECT_THERAPY)).toBe(true);
    });

    it('retorna true para "fonoaudiologia"', () => {
        expect(isAutoResume('fonoaudiologia', STATES.COLLECT_THERAPY)).toBe(true);
    });

    it('retorna true para "fono"', () => {
        expect(isAutoResume('fono', STATES.COLLECT_THERAPY)).toBe(true);
    });

    it('retorna true para "psicologia"', () => {
        expect(isAutoResume('psicologia', STATES.COLLECT_THERAPY)).toBe(true);
    });

    it('retorna true para "psico"', () => {
        expect(isAutoResume('psico', STATES.COLLECT_THERAPY)).toBe(true);
    });

    it('retorna true para "fisioterapia"', () => {
        expect(isAutoResume('fisioterapia', STATES.COLLECT_THERAPY)).toBe(true);
    });

    it('retorna true para "neuropsico" (prefixo sem sufixo completo)', () => {
        expect(isAutoResume('neuropsico', STATES.COLLECT_THERAPY)).toBe(true);
    });

    it('retorna true para "quero fisio para minha filha"', () => {
        expect(isAutoResume('quero fisio para minha filha', STATES.COLLECT_THERAPY)).toBe(true);
    });

    it('retorna false para mensagem genérica sem especialidade', () => {
        expect(isAutoResume('ok entendi', STATES.COLLECT_THERAPY)).toBe(false);
    });

    it('retorna false para texto vazio', () => {
        expect(isAutoResume('', STATES.COLLECT_THERAPY)).toBe(false);
    });

    it('retorna false para null', () => {
        expect(isAutoResume(null, STATES.COLLECT_THERAPY)).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════
// [FEAT] isAutoResume — COLLECT_NEURO_TYPE retomada automática
// ═══════════════════════════════════════════════════════════════
describe('[FEAT] isAutoResume — COLLECT_NEURO_TYPE', () => {
    it('retorna true para "laudo"', () => {
        expect(isAutoResume('laudo', STATES.COLLECT_NEURO_TYPE)).toBe(true);
    });

    it('retorna true para "quero o laudo completo"', () => {
        expect(isAutoResume('quero o laudo completo', STATES.COLLECT_NEURO_TYPE)).toBe(true);
    });

    it('retorna true para "relatório"', () => {
        expect(isAutoResume('relatório', STATES.COLLECT_NEURO_TYPE)).toBe(true);
    });

    it('retorna true para "diagnóstico"', () => {
        expect(isAutoResume('diagnóstico', STATES.COLLECT_NEURO_TYPE)).toBe(true);
    });

    it('retorna true para "acompanhamento"', () => {
        expect(isAutoResume('acompanhamento', STATES.COLLECT_NEURO_TYPE)).toBe(true);
    });

    it('retorna true para "terapia"', () => {
        expect(isAutoResume('terapia', STATES.COLLECT_NEURO_TYPE)).toBe(true);
    });

    it('retorna true para "sessões"', () => {
        expect(isAutoResume('sessões', STATES.COLLECT_NEURO_TYPE)).toBe(true);
    });

    it('retorna false para "ok" sem keywords', () => {
        expect(isAutoResume('ok', STATES.COLLECT_NEURO_TYPE)).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════
// [REG] isAutoResume — estados existentes não quebrados
// ═══════════════════════════════════════════════════════════════
describe('[REG] isAutoResume — estados existentes preservados', () => {
    it('COLLECT_NAME: detecta nome "João Silva"', () => {
        expect(isAutoResume('João Silva', STATES.COLLECT_NAME)).toBe(true);
    });

    it('COLLECT_BIRTH: detecta "5 anos"', () => {
        expect(isAutoResume('5 anos', STATES.COLLECT_BIRTH)).toBe(true);
    });

    it('COLLECT_BIRTH: detecta data "12/05/2018"', () => {
        expect(isAutoResume('12/05/2018', STATES.COLLECT_BIRTH)).toBe(true);
    });

    it('COLLECT_PERIOD: detecta "manhã"', () => {
        expect(isAutoResume('manhã', STATES.COLLECT_PERIOD)).toBe(true);
    });

    it('COLLECT_PERIOD: detecta "tarde"', () => {
        expect(isAutoResume('tarde', STATES.COLLECT_PERIOD)).toBe(true);
    });

    it('SHOW_SLOTS: detecta "A"', () => {
        expect(isAutoResume('A', STATES.SHOW_SLOTS)).toBe(true);
    });

    it('CONFIRM_BOOKING: detecta "sim"', () => {
        expect(isAutoResume('sim', STATES.CONFIRM_BOOKING)).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════
// [FEAT] getResumeHint — COLLECT_NEURO_TYPE tem hint
// ═══════════════════════════════════════════════════════════════
describe('[FEAT] getResumeHint — COLLECT_NEURO_TYPE', () => {
    it('retorna hint não-vazio para COLLECT_NEURO_TYPE', () => {
        const hint = getResumeHint(STATES.COLLECT_NEURO_TYPE);
        expect(hint).toBeTruthy();
        expect(typeof hint).toBe('string');
        expect(hint.length).toBeGreaterThan(5);
    });

    it('hint de COLLECT_NEURO_TYPE menciona laudo ou acompanhamento', () => {
        const hint = getResumeHint(STATES.COLLECT_NEURO_TYPE).toLowerCase();
        const hasLaudo = hint.includes('laudo');
        const hasAcomp = hint.includes('acompanhamento');
        expect(hasLaudo || hasAcomp).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════
// [REG] detectGlobalIntent — não confunde especialidades com intents
// ═══════════════════════════════════════════════════════════════
describe('[REG] detectGlobalIntent — especialidades não disparam intent', () => {
    it('"Neuropsicologia" não dispara PRICE_QUERY', () => {
        expect(detectGlobalIntent('Neuropsicologia')).toBeNull();
    });

    it('"fonoaudiologia" não dispara nenhum global intent', () => {
        expect(detectGlobalIntent('fonoaudiologia')).toBeNull();
    });

    it('"preço" dispara PRICE_QUERY (regressão)', () => {
        expect(detectGlobalIntent('qual é o preço?')).toBe('PRICE_QUERY');
    });

    it('"valor" dispara PRICE_QUERY (regressão)', () => {
        expect(detectGlobalIntent('quanto custa?')).toBe('PRICE_QUERY');
    });

    it('"endereço" dispara LOCATION_QUERY (regressão)', () => {
        expect(detectGlobalIntent('qual o endereço?')).toBe('LOCATION_QUERY');
    });

    it('"plano" dispara INSURANCE_QUERY (regressão)', () => {
        expect(detectGlobalIntent('aceita plano de saúde?')).toBe('INSURANCE_QUERY');
    });
});

// ═══════════════════════════════════════════════════════════════
// [FEAT] detectGlobalIntent — LAUDO_QUERY
// ═══════════════════════════════════════════════════════════════
describe('[FEAT] detectGlobalIntent — LAUDO_QUERY', () => {
    it('"psicólogos emitem laudo?" dispara LAUDO_QUERY', () => {
        expect(detectGlobalIntent('As psicólogas ou psicólogos emitem laudo?')).toBe('LAUDO_QUERY');
    });

    it('"quem emite laudo?" dispara LAUDO_QUERY', () => {
        expect(detectGlobalIntent('quem emite laudo?')).toBe('LAUDO_QUERY');
    });

    it('"vocês emitem laudo?" dispara LAUDO_QUERY', () => {
        expect(detectGlobalIntent('vocês emitem laudo?')).toBe('LAUDO_QUERY');
    });

    it('"faz laudo?" dispara LAUDO_QUERY', () => {
        expect(detectGlobalIntent('faz laudo?')).toBe('LAUDO_QUERY');
    });

    it('"precisa de laudo?" dispara LAUDO_QUERY', () => {
        expect(detectGlobalIntent('precisa de laudo?')).toBe('LAUDO_QUERY');
    });

    it('"tem laudo?" dispara LAUDO_QUERY', () => {
        expect(detectGlobalIntent('tem laudo?')).toBe('LAUDO_QUERY');
    });

    it('"laudo é emitido?" dispara LAUDO_QUERY', () => {
        expect(detectGlobalIntent('laudo é emitido pela neuropsicóloga?')).toBe('LAUDO_QUERY');
    });

    it('texto sem menção a laudo não dispara LAUDO_QUERY', () => {
        expect(detectGlobalIntent('quero agendar uma consulta')).toBeNull();
    });

    it('"laudo" isolado dispara LAUDO_QUERY', () => {
        expect(detectGlobalIntent('laudo')).toBe('LAUDO_QUERY');
    });
});
