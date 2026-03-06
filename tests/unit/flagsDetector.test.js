/**
 * 🧪 TESTES UNITÁRIOS - flagsDetector.js
 * Validam correções de falsos positivos em givingUp
 */

import { describe, it, expect } from 'vitest';
import { detectAllFlags } from '../../utils/flagsDetector.js';

describe('🚨 CORREÇÃO: givingUp falsos positivos', () => {
    
    describe('✅ NÃO deve detectar givingUp em contextos inocentes', () => {
        const casosInocentes = [
            'Olá! Fique à vontade para nos contar',
            'Isso é para você',
            'Ela chega às 10h',
            'Para mim está bom',
            'Onde fica a clínica para eu chegar?',
            'Quero agendar para amanhã'
        ];

        casosInocentes.forEach(texto => {
            it(`"${texto.substring(0, 40)}..." → givingUp deve ser false`, () => {
                const flags = detectAllFlags(texto);
                expect(flags.givingUp).toBe(false);
            });
        });
    });

    describe('✅ DEVE detectar givingUp em contextos de desistência real', () => {
        const casosDesistencia = [
            'Chega de esperar',
            'Basta, não aguento mais',
            'Para de me ligar',
            'Para com isso',
            'Desisto'
        ];

        casosDesistencia.forEach(texto => {
            it(`"${texto}" → givingUp deve ser true`, () => {
                const flags = detectAllFlags(texto);
                expect(flags.givingUp).toBe(true);
            });
        });
    });

    describe('✅ Casos específicos do log de produção', () => {
        it('template "Fique à vontade para nos contar" → givingUp: false', () => {
            const texto = 'Olá! 😊\nSeja bem-vindo(a) à Clínica Fono Inova 💚 Fique à vontade para nos contar o que te trouxe até aqui ou como podemos te ajudar.';
            const flags = detectAllFlags(texto);
            expect(flags.givingUp).toBe(false);
        });

        it('"Chega de esperar" → givingUp: true', () => {
            const flags = detectAllFlags('Chega de esperar, vou procurar outra clínica');
            expect(flags.givingUp).toBe(true);
        });
    });
});

// Nota: preferredPeriod é detectado por extractPeriodFromText, não por detectAllFlags
// Testes de período estão em patientDataExtractor.test.js
