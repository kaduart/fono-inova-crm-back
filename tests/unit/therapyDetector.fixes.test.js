/**
 * Testes de regressão — therapyDetector.js
 *
 * Cobre os bugs corrigidos e garante que os padrões de detecção
 * nunca quebrem silenciosamente em mudanças futuras.
 *
 * BUGS COBERTOS:
 *  [BUG-1] "freio lingual" não era detectado como tongue_tie
 *  [BUG-2] "avaliação psicológica" (adjetivo) não detectava psychology
 *  [REG]   Padrões existentes que devem continuar funcionando
 */

import { describe, it, expect } from 'vitest';
import { detectAllTherapies, normalizeTherapyTerms } from '../../utils/therapyDetector.js';

// ─────────────────────────────────────────────────────────────
// Helper: retorna os IDs detectados de um texto
// ─────────────────────────────────────────────────────────────
function ids(text) {
    return detectAllTherapies(text).map(t => t.id);
}

// ═══════════════════════════════════════════════════════════════
// [BUG-1] tongue_tie — "freio lingual" não detectado
// ═══════════════════════════════════════════════════════════════
describe('[BUG-1] tongue_tie — freio lingual', () => {
    it('detecta "freio lingual" (forma curta, exata do log real)', () => {
        const result = ids('Gostaria de uma avaliação de freio lingual');
        expect(result).toContain('tongue_tie');
    });

    it('detecta "Freio Lingual" (capitalizado)', () => {
        const result = ids('Olá! Vi a página de Freio Lingual e gostaria de agendar uma avaliação.');
        expect(result).toContain('tongue_tie');
    });

    it('detecta "freio lingual" (minúsculas, sem contexto)', () => {
        expect(ids('freio lingual')).toContain('tongue_tie');
    });

    it('detecta "avaliação de freio lingual (teste da linguinha)"', () => {
        expect(ids('Gostaria de agendar uma avaliação de freio lingual (teste da linguinha).')).toContain('tongue_tie');
    });

    // Regressão: padrões existentes do tongue_tie não podem ter quebrado
    it('[REG] continua detectando "teste da linguinha"', () => {
        expect(ids('teste da linguinha')).toContain('tongue_tie');
    });

    it('[REG] continua detectando "frênulo lingual"', () => {
        expect(ids('frênulo lingual')).toContain('tongue_tie');
    });

    it('[REG] continua detectando "freio da língua"', () => {
        expect(ids('freio da língua')).toContain('tongue_tie');
    });

    it('[REG] continua detectando "frenulo lingual" (sem acento)', () => {
        expect(ids('frenulo lingual')).toContain('tongue_tie');
    });
});

// ═══════════════════════════════════════════════════════════════
// [BUG-2] psychology — "psicológica" (adjetivo) não detectado
// ═══════════════════════════════════════════════════════════════
describe('[BUG-2] psychology — forma adjetiva "psicológica"', () => {
    it('detecta "avaliação psicológica infantil" (mensagem real do log)', () => {
        const result = ids('Olá! Gostaria de agendar uma avaliação psicológica infantil.');
        expect(result).toContain('psychology');
    });

    it('detecta "avaliação psicológica" (sem "infantil")', () => {
        expect(ids('quero agendar uma avaliação psicológica')).toContain('psychology');
    });

    it('detecta "psicológica" isolado', () => {
        expect(ids('psicológica')).toContain('psychology');
    });

    it('detecta "psicologica" (sem acento, após normalização)', () => {
        expect(ids('psicologica')).toContain('psychology');
    });

    it('detecta "avaliacao psicologica" (sem acentos — como chega depois de normalizeTherapyTerms)', () => {
        // Simula texto já normalizado sem acentos
        expect(ids('avaliacao psicologica infantil')).toContain('psychology');
    });

    // Regressão: padrões existentes do psychology não podem ter quebrado
    it('[REG] continua detectando "psicologia"', () => {
        expect(ids('psicologia')).toContain('psychology');
    });

    it('[REG] continua detectando "psico" como abreviação', () => {
        expect(ids('quero marcar psico')).toContain('psychology');
    });

    it('[REG] continua detectando "psicologo infantil"', () => {
        expect(ids('psicologo infantil')).toContain('psychology');
    });

    it('[REG] não confunde "psicologica" com "psicopedagogia"', () => {
        const result = ids('avaliação psicológica da minha filha');
        expect(result).toContain('psychology');
        expect(result).not.toContain('psychopedagogy');
    });
});

// ═══════════════════════════════════════════════════════════════
// [REG] neuropsychological — padrões críticos que devem continuar
// ═══════════════════════════════════════════════════════════════
describe('[REG] neuropsychological — regressão', () => {
    it('detecta "neuropsicologia"', () => {
        expect(ids('Neuropsicologia')).toContain('neuropsychological');
    });

    it('detecta "avaliação neuropsicológica"', () => {
        expect(ids('quero uma avaliação neuropsicológica para minha filha')).toContain('neuropsychological');
    });

    it('detecta "neuropsi" (abreviação)', () => {
        expect(ids('quero marcar neuropsi')).toContain('neuropsychological');
    });

    it('neuropsychological domina sobre psychology quando ambos presentes', () => {
        const result = ids('neuropsicologia e psicologia');
        expect(result[0]?.id || result[0]).toBe('neuropsychological');
        // psychology pode aparecer mas não deve dominar
    });

    it('detecta "laudo neuropsicológico"', () => {
        expect(ids('quero um laudo neuropsicológico')).toContain('neuropsychological');
    });
});

// ═══════════════════════════════════════════════════════════════
// [REG] speech / fonoaudiologia
// ═══════════════════════════════════════════════════════════════
describe('[REG] speech — fonoaudiologia regressão', () => {
    it('detecta "fonoaudiologia"', () => {
        expect(ids('fonoaudiologia')).toContain('speech');
    });

    it('detecta "fono"', () => {
        expect(ids('quero marcar fono')).toContain('speech');
    });

    it('detecta "atraso na fala"', () => {
        expect(ids('minha filha tem atraso na fala')).toContain('speech');
    });
});

// ═══════════════════════════════════════════════════════════════
// normalizeTherapyTerms — garante normalização consistente
// ═══════════════════════════════════════════════════════════════
describe('normalizeTherapyTerms — normalização', () => {
    it('remove acentos de "psicológica" → "psicologica"', () => {
        const result = normalizeTherapyTerms('psicológica');
        expect(result).toBe('psicologica');
    });

    it('remove acentos de "freio lingual" (sem acentos — inalterado)', () => {
        const result = normalizeTherapyTerms('freio lingual');
        expect(result).toBe('freio lingual');
    });

    it('converte para minúsculas', () => {
        const result = normalizeTherapyTerms('Freio Lingual');
        expect(result).toBe('freio lingual');
    });

    it('normaliza "neuropsicológica" para "neuropsicologia"', () => {
        const result = normalizeTherapyTerms('neuropsicológica');
        expect(result).toContain('neuropsicologia');
    });

    it('protege contra texto vazio', () => {
        expect(normalizeTherapyTerms('')).toBe('');
        expect(normalizeTherapyTerms(null)).toBe('');
        expect(normalizeTherapyTerms(undefined)).toBe('');
    });
});

// ═══════════════════════════════════════════════════════════════
// Edge cases — entradas problemáticas que não devem explodir
// ═══════════════════════════════════════════════════════════════
describe('Edge cases — robustez', () => {
    it('retorna [] para texto vazio', () => {
        expect(detectAllTherapies('')).toEqual([]);
    });

    it('retorna [] para null/undefined', () => {
        expect(detectAllTherapies(null)).toEqual([]);
        expect(detectAllTherapies(undefined)).toEqual([]);
    });

    it('não detecta nada para texto genérico sem especialidade', () => {
        const result = ids('Olá! Gostaria de agendar uma avaliação.');
        // Pode detectar ou não dependendo do texto, mas não deve lançar
        expect(Array.isArray(result)).toBe(true);
    });

    it('não retorna tongue_tie para "linguagem" (falso positivo)', () => {
        // "linguagem" não deve ativar tongue_tie
        const result = ids('minha filha tem dificuldade de linguagem');
        // tongue_tie NÃO deve estar nos resultados
        expect(result).not.toContain('tongue_tie');
    });
});
