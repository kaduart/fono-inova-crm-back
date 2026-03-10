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

import { detectMedicalSpecialty, validateServiceAvailability, asksSpecialtyAvailability } from '../../utils/flagsDetector.js';

describe('🩺 Detecção de Especialidades Médicas', () => {
    
    describe('detectMedicalSpecialty', () => {
        const testCases = [
            { text: 'Vocês têm neuropediatra?', expected: 'neurologista', redirectTo: 'neuropsicologia' },
            { text: 'Preciso de neuro pediatra', expected: 'neurologista', redirectTo: 'neuropsicologia' },
            { text: 'Tem neuropediatria?', expected: 'neurologista', redirectTo: 'neuropsicologia' },
            { text: 'Gostaria de consulta com pediatra', expected: 'pediatra', redirectTo: 'fonoaudiologia' },
            { text: 'Preciso de psiquiatra para meu filho', expected: 'psiquiatra', redirectTo: 'psicologia' },
            { text: 'Quero fazer fonoaudiologia', expected: null }, // não é médica
            { text: 'Psicologia infantil', expected: null }, // não é médica
        ];

        testCases.forEach(({ text, expected, redirectTo }) => {
            it(`"${text.substring(0, 40)}..." → ${expected || 'não é médica'}`, () => {
                const result = detectMedicalSpecialty(text);
                if (expected) {
                    expect(result).not.toBeNull();
                    expect(result.specialty).toBe(expected);
                    expect(result.redirectTo).toBe(redirectTo);
                    expect(result.message).toBeTruthy();
                } else {
                    expect(result).toBeNull();
                }
            });
        });

        it('não deve confundir neuropediatra com pediatra', () => {
            const result = detectMedicalSpecialty('neuropediatria');
            expect(result).not.toBeNull();
            expect(result.specialty).toBe('neurologista');
            expect(result.specialty).not.toBe('pediatra');
        });

        it('não deve confundir neuropsicologia com neuropediatra', () => {
            const result = detectMedicalSpecialty('neuropsicologia');
            // Neuropsicologia NÃO deve ser detectada como especialidade médica
            // (é uma terapia válida da clínica)
            expect(result).toBeNull();
        });
    });

    describe('validateServiceAvailability', () => {
        it('deve validar fonoaudiologia como disponível', () => {
            const result = validateServiceAvailability('Quero fonoaudiologia');
            expect(result.valid).toBe(true);
            expect(result.service).toBe('fonoaudiologia');
        });

        it('deve validar terapia ocupacional como disponível', () => {
            const result = validateServiceAvailability('Tem terapeuta ocupacional?');
            expect(result.valid).toBe(true);
            expect(result.service).toBe('terapia_ocupacional');
        });

        it('deve detectar neuropediatra como indisponível', () => {
            const result = validateServiceAvailability('Preciso de neuropediatra');
            expect(result.valid).toBe(false);
            expect(result.isMedicalSpecialty).toBe(true);
            expect(result.redirect).toBe('neuropsicologia');
        });
    });

    describe('asksSpecialtyAvailability', () => {
        const availabilityQuestions = [
            'Vocês têm psicólogo?',
            'Tem fono aí?',
            'Vocês tem fonoaudiologia?',
            'Vocês atendem neuropsicologia?',
        ];

        availabilityQuestions.forEach(text => {
            it(`"${text}" → deve detectar pergunta de disponibilidade`, () => {
                const flags = detectAllFlags(text);
                expect(flags.asksSpecialtyAvailability).toBe(true);
            });
        });

        const nonQuestions = [
            'Quero fono',
            'Preciso de psicologia',
            'Fisioterapia',
        ];

        nonQuestions.forEach(text => {
            it(`"${text}" → NÃO deve detectar como pergunta de disponibilidade`, () => {
                const flags = detectAllFlags(text);
                expect(flags.asksSpecialtyAvailability).toBeFalsy();
            });
        });
    });
});
// Testes de período estão em patientDataExtractor.test.js


// ═══════════════════════════════════════════════════════════════
// [FEAT] Novas flags de perfil comportamental
// isEmotional, isJustBrowsing, isHotLead
// ═══════════════════════════════════════════════════════════════

describe('[FEAT] Flags de perfil comportamental', () => {
    
    describe('isEmotional - detecta leads preocupados/ansiosos', () => {
        const casosEmocionais = [
            { texto: 'estou preocupada com meu filho', desc: 'preocupada' },
            { texto: 'Não sei o que fazer, estou desesperada', desc: 'desesperada' },
            { texto: 'Me ajuda, estou chorando aqui', desc: 'chorando' },
            { texto: 'estou ansiosa demais com isso', desc: 'ansiosa' },
            { texto: 'estou angustiada, preciso de ajuda', desc: 'angustiada' },
            { texto: 'desesperada, não aguento mais', desc: 'nao aguento mais' },
            { texto: 'estou perdida, não sei por onde começar', desc: 'perdida' },
        ];

        casosEmocionais.forEach(({ texto, desc }) => {
            it(`${desc} → isEmotional: true`, () => {
                const flags = detectAllFlags(texto);
                expect(flags.isEmotional).toBe(true);
            });
        });

        const casosNaoEmocionais = [
            'Quero agendar uma avaliação',
            'Qual o preço da consulta?',
            'Bom dia, gostaria de saber mais',
        ];

        casosNaoEmocionais.forEach(texto => {
            it(`"${texto.substring(0, 40)}..." → isEmotional: false`, () => {
                const flags = detectAllFlags(texto);
                expect(flags.isEmotional).toBe(false);
            });
        });
    });

    describe('isJustBrowsing - detecta leads só pesquisando', () => {
        const casosPesquisando = [
            'só olhando as opções',
            'só pesquisando por enquanto',
            'tirando dúvida',
            'só queria saber o preço',
            'ainda não decidi nada',
            'só vi no instagram e resolvi perguntar',
        ];

        casosPesquisando.forEach(texto => {
            it(`"${texto.substring(0, 40)}..." → isJustBrowsing: true`, () => {
                const flags = detectAllFlags(texto);
                expect(flags.isJustBrowsing).toBe(true);
            });
        });
    });

    describe('isHotLead - detecta leads prontos para agendar', () => {
        const casosHotLead = [
            'quero agendar logo',
            'pode marcar para essa semana',
            'quando tem vaga',
            'quero começar o quanto antes',
            'vamos fazer isso',
            'quero marcar hoje',
            'pode fechar o horário',
        ];

        casosHotLead.forEach(texto => {
            it(`"${texto.substring(0, 40)}..." → isHotLead: true`, () => {
                const flags = detectAllFlags(texto);
                expect(flags.isHotLead).toBe(true);
            });
        });
    });
});
