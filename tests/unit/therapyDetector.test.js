#!/usr/bin/env node
/**
 * 🧪 TESTES UNITÁRIOS - therapyDetector.js
 * 
 * Testes para garantir que detectAllTherapies não quebre com inputs inesperados
 */

import { detectAllTherapies, pickPrimaryTherapy, normalizeTherapyTerms } from '../../utils/therapyDetector.js';

const c = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    cyan: '\x1b[36m'
};

function log(color, msg) { console.log(`${color}${msg}${c.reset}`); }

const TEST_CASES = [
    {
        name: 'Texto vazio',
        text: '',
        expectEmpty: true
    },
    {
        name: 'undefined',
        text: undefined,
        expectEmpty: true
    },
    {
        name: 'null',
        text: null,
        expectEmpty: true
    },
    {
        name: '"Qual o valor" - caso do log (sem contexto de terapia)',
        text: 'Qual o valor',
        expectEmpty: true
    },
    {
        name: '"Quanto custa" - pergunta de preço',
        text: 'Quanto custa a avaliação?',
        expectEmpty: true
    },
    {
        name: 'Apenas saudação',
        text: 'Olá, boa tarde',
        expectEmpty: true
    },
    {
        name: 'Fonoaudiologia - deve detectar',
        text: 'Quero agendar fonoaudiologia',
        expectContains: 'speech'
    },
    {
        name: 'Psicologia - deve detectar',
        text: 'Preciso de psicólogo',
        expectContains: 'psychology'
    },
    {
        name: 'Neuropsicologia - deve detectar',
        text: 'Quero avaliação neuropsicológica',
        expectContains: 'neuropsychological'
    }
];

function runTest(tc) {
    try {
        const result = detectAllTherapies(tc.text);
        
        if (tc.expectEmpty) {
            if (result.length === 0) {
                log(c.green, `✅ ${tc.name}`);
                return true;
            } else {
                log(c.red, `❌ ${tc.name} - Esperado vazio, mas retornou: ${JSON.stringify(result.map(r => r.id))}`);
                return false;
            }
        }
        
        if (tc.expectContains) {
            const hasMatch = result.some(r => r.id === tc.expectContains);
            if (hasMatch) {
                log(c.green, `✅ ${tc.name}`);
                return true;
            } else {
                log(c.red, `❌ ${tc.name} - Esperado ${tc.expectContains}, mas retornou: ${JSON.stringify(result.map(r => r.id))}`);
                return false;
            }
        }
        
        log(c.green, `✅ ${tc.name}`);
        return true;
    } catch (err) {
        log(c.red, `💥 ${tc.name} - ERRO: ${err.message}`);
        return false;
    }
}

console.log(`\n🧪 TESTES - therapyDetector.js\n`);

let passed = 0;
let failed = 0;

for (const tc of TEST_CASES) {
    if (runTest(tc)) {
        passed++;
    } else {
        failed++;
    }
}

console.log(`\n📊 Resultado: ${passed}/${TEST_CASES.length} passaram`);
if (failed > 0) {
    console.log(`   ❌ ${failed} falhas`);
    process.exit(1);
}
console.log('✅ Todos os testes passaram!');
process.exit(0);
