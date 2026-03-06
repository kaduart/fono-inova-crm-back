/**
 * 🧪 Testes das Correções em flagsDetector
 * Valida detecção de desistência
 */

import { describe, it, expect } from 'vitest';
import { deriveFlagsFromText } from '../../utils/flagsDetector.js';

describe('✅ Correções - flagsDetector', () => {

    describe('🚨 FIX: givingUp não deve acionar em falsos positivos', () => {
        
        it('"vou para o trabalho" → NÃO deve dar givingUp', () => {
            const result = deriveFlagsFromText('vou para o trabalho agora');
            expect(result.givingUp).toBe(false);
        });

        it('"ela chega às 10h" → NÃO deve dar givingUp', () => {
            const result = deriveFlagsFromText('ela chega às 10h');
            expect(result.givingUp).toBe(false);
        });

        it('"chega de esperar" → DEVE dar givingUp', () => {
            const result = deriveFlagsFromText('chega de esperar por isso');
            expect(result.givingUp).toBe(true);
        });

        it('"basta" → DEVE dar givingUp', () => {
            const result = deriveFlagsFromText('basta já');
            expect(result.givingUp).toBe(true);
        });

        it('"para de me ligar" → DEVE dar givingUp', () => {
            const result = deriveFlagsFromText('para de me ligar');
            expect(result.givingUp).toBe(true);
        });

        it('"para o escritório" → NÃO deve dar givingUp', () => {
            const result = deriveFlagsFromText('vou para o escritório');
            expect(result.givingUp).toBe(false);
        });
    });
});
