#!/usr/bin/env node
/**
 * 🧪 TESTE UNITÁRIO: flagsDetector.js
 * 
 * Testa detecção de flags sem necessidade de MongoDB
 * Rápido para executar em CI/CD
 */

import { deriveFlagsFromText } from '../../utils/flagsDetector.js';

const TESTS = [
    // PONTO 1: Desambiguação "vaga"
    {
        name: 'P1: "Quais os dias tem vaga" → wantsSchedule=true, parceria=false',
        input: 'Quais os dias tem vaga',
        expect: { wantsSchedule: true, wantsPartnershipOrResume: false }
    },
    {
        name: 'P1: "Tem vaga de trabalho" → parceria=true',
        input: 'Tem vaga de trabalho',
        expect: { wantsPartnershipOrResume: true }
    },
    {
        name: 'P1: "Gostaria de enviar currículo" → parceria=true',
        input: 'Gostaria de enviar meu currículo',
        expect: { wantsPartnershipOrResume: true }
    },
    
    // PONTO 2: Mais cedo / alternativas
    {
        name: 'P2: "Não tem pra mais cedo" → wantsMoreOptions=true',
        input: 'Não tem pra mais cedo não?',
        expect: { wantsSchedule: true, wantsMoreOptions: true }
    },
    {
        name: 'P2: "Tem outro horário" → wantsMoreOptions=true',
        input: 'Tem outro horário disponível?',
        expect: { wantsSchedule: true, wantsMoreOptions: true }
    },
    
    // Outros casos importantes
    {
        name: 'Agendamento normal',
        input: 'Quero agendar uma consulta',
        expect: { wantsSchedule: true, wantsPartnershipOrResume: false }
    },
    {
        name: 'Parceria explícita',
        input: 'Sou fonoaudióloga e quero trabalhar com vocês',
        expect: { wantsPartnershipOrResume: true }
    }
];

let passed = 0;
let failed = 0;

console.log('\n🧪 Testes Unitários: flagsDetector.js\n');

for (const test of TESTS) {
    const flags = deriveFlagsFromText(test.input);
    let ok = true;
    
    for (const [key, value] of Object.entries(test.expect)) {
        if (flags[key] !== value) {
            ok = false;
            console.log(`❌ ${test.name}`);
            console.log(`   Input: "${test.input}"`);
            console.log(`   ${key}: esperado=${value}, obtido=${flags[key]}`);
        }
    }
    
    if (ok) {
        console.log(`✅ ${test.name}`);
        passed++;
    } else {
        failed++;
    }
}

console.log(`\n📊 Resultado: ${passed}/${TESTS.length} passaram${failed > 0 ? ` | ${failed} falharam` : ''}\n`);

process.exit(failed > 0 ? 1 : 0);
