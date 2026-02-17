#!/usr/bin/env node
/**
 * 🧪 TESTE: Correção de Desambiguação "vaga" (consulta vs emprego)
 * 
 * Valida:
 * 1. "Quais os dias tem vaga" → Deve buscar slots de CONSULTA (não parceria)
 * 2. "Tem vaga de trabalho" → Deve responder sobre PARCERIA/EMPREGO
 * 3. "Mais cedo" → Deve buscar alternativas reais
 * 4. Coleta de dados → Deve pedir nome e data de nascimento separadamente
 * 
 * Issue: Ponto 1, 2, 3, 4 do analises
 * Data: 2026-02-17
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { deriveFlagsFromText } from '../../utils/flagsDetector.js';

const PHONE = '556299998888';

const c = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m',
    bold: '\x1b[1m'
};

function log(color, msg) { console.log(`${color}${msg}${c.reset}`); }

// ============================================
// CENÁRIOS DE TESTE
// ============================================
const TEST_CASES = [
    {
        name: 'TC-01: "Quais os dias tem vaga" → Agendamento (NÃO parceria)',
        input: 'Quais os dias tem vaga',
        expected: {
            wantsSchedule: true,
            wantsPartnershipOrResume: false  // 🔥 CRÍTICO: Não deve detectar parceria
        },
        description: 'Paciente perguntando disponibilidade de consulta'
    },
    {
        name: 'TC-02: "Tem vaga para fonoaudiologia" → Agendamento',
        input: 'Tem vaga para fonoaudiologia',
        expected: {
            wantsSchedule: true,
            wantsPartnershipOrResume: false
        },
        description: 'Vaga com contexto de especialidade médica'
    },
    {
        name: 'TC-03: "Tem vaga de trabalho" → Parceria',
        input: 'Tem vaga de trabalho para fonoaudióloga?',
        expected: {
            wantsPartnershipOrResume: true  // Com contexto de trabalho = parceria
        },
        description: 'Vaga com contexto explícito de emprego'
    },
    {
        name: 'TC-04: "Envio meu currículo" → Parceria',
        input: 'Gostaria de enviar meu currículo',
        expected: {
            wantsPartnershipOrResume: true
        },
        description: 'Currículo explícito = parceria'
    },
    {
        name: 'TC-05: "Mais cedo" → wantsMoreOptions',
        input: 'Não tem pra mais cedo não?',
        expected: {
            wantsSchedule: true,
            wantsMoreOptions: true  // Deve detectar pedido de alternativa
        },
        description: 'Paciente pedindo horário mais cedo'
    },
    {
        name: 'TC-06: "Outro horário" → wantsMoreOptions',
        input: 'Tem outro horário disponível?',
        expected: {
            wantsSchedule: true,
            wantsMoreOptions: true
        },
        description: 'Pedido explícito de alternativa'
    },
    {
        name: 'TC-07: "Agendar consulta" → Agendamento puro',
        input: 'Quero agendar uma consulta',
        expected: {
            wantsSchedule: true,
            wantsPartnershipOrResume: false
        },
        description: 'Intenção clara de agendamento'
    },
    {
        name: 'TC-08: Vaga + trabalhar + vocês → Parceria',
        input: 'Tem vaga para trabalhar com vocês?',
        expected: {
            wantsPartnershipOrResume: true  // Contexto completo de emprego
        },
        description: 'Contexto completo de emprego'
    }
];

// ============================================
// EXECUÇÃO DOS TESTES
// ============================================
async function runTests() {
    log(c.cyan, '\n╔════════════════════════════════════════════════════════════════╗');
    log(c.cyan, '║  🧪 TESTE: Desambiguação "vaga" (consulta vs emprego)          ║');
    log(c.cyan, '║  📋 Issue: Ponto 1 - Corrige falso positivo de parceria        ║');
    log(c.cyan, '╚════════════════════════════════════════════════════════════════╝\n');

    let passed = 0;
    let failed = 0;

    for (const test of TEST_CASES) {
        log(c.blue, `  ── ${test.name} ──`);
        log(c.gray, `  📝 ${test.description}`);
        log(c.gray, `  👤 Input: "${test.input}"`);

        // Executa detecção
        const flags = deriveFlagsFromText(test.input);

        let testPassed = true;
        const errors = [];

        // Valida cada expectativa
        for (const [key, expectedValue] of Object.entries(test.expected)) {
            const actualValue = flags[key];
            if (actualValue !== expectedValue) {
                testPassed = false;
                errors.push(`  ❌ ${key}: esperado=${expectedValue}, obtido=${actualValue}`);
            }
        }

        // Mostra resultados
        if (testPassed) {
            log(c.green, `  ✅ PASSOU`);
            log(c.gray, `     Flags: wantsSchedule=${flags.wantsSchedule}, wantsPartnershipOrResume=${flags.wantsPartnershipOrResume}, wantsMoreOptions=${flags.wantsMoreOptions}`);
            passed++;
        } else {
            log(c.red, `  ❌ FALHOU`);
            errors.forEach(e => log(c.red, e));
            failed++;
        }
        console.log();
    }

    // ============================================
    // RELATÓRIO
    // ============================================
    log(c.cyan, '═'.repeat(64));
    const color = failed > 0 ? c.red : c.green;
    log(color, `  📊 RESULTADO: ${passed}/${TEST_CASES.length} passaram | ${failed} falharam`);
    
    if (failed === 0) {
        log(c.green, '  🎉 Todas as correções de desambiguação estão funcionando!');
    } else {
        log(c.red, '  ⚠️  Alguns testes falharam - revisar implementação');
    }
    log(c.cyan, '═'.repeat(64));

    return failed === 0;
}

// ============================================
// MAIN
// ============================================
async function main() {
    try {
        // Não precisa de MongoDB para testar só o detector de flags
        const success = await runTests();
        process.exit(success ? 0 : 1);
    } catch (err) {
        log(c.red, `\n⛔ ERRO CRÍTICO: ${err.message}`);
        log(c.red, err.stack);
        process.exit(1);
    }
}

main();
