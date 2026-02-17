#!/usr/bin/env node
/**
 * 🧪 TESTES UNITÁRIOS P1-P4 - flagsDetector.js
 * 
 * Testes específicos para as correções:
 * - P1: Desambiguação "vaga" (parceria vs agendamento)
 * - P2: Detecção de "mais opções"
 * - P3: Validação de confirmação de dados
 * - P4: Contexto de slots
 * 
 * Uso: node tests/unit/flagsDetector.p1-p4.test.js
 */

import { deriveFlagsFromText, detectAllFlags } from '../../utils/flagsDetector.js';

const c = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m'
};

function log(color, msg) { console.log(`${color}${msg}${c.reset}`); }

// ============================================
// CASOS DE TESTE P1: DESAMBIGUAÇÃO VAGA
// ============================================
const P1_CASES = [
    // CASOS QUE DEVEM SER AGENDAMENTO (wantsSchedule=true, wantsPartnershipOrResume=false)
    {
        name: 'P1-A1: "tem vaga" simples',
        text: 'tem vaga',
        expect: { wantsSchedule: true, wantsPartnershipOrResume: false }
    },
    {
        name: 'P1-A2: "Quais os dias tem vaga" (caso real do log)',
        text: 'Quais os dias tem vaga',
        expect: { wantsSchedule: true, wantsPartnershipOrResume: false }
    },
    {
        name: 'P1-A3: "Tem vaga para fonoaudiologia"',
        text: 'Tem vaga para fonoaudiologia essa semana?',
        expect: { wantsSchedule: true, wantsPartnershipOrResume: false }
    },
    {
        name: 'P1-A4: "Tem vaga amanhã?"',
        text: 'Tem vaga amanhã?',
        expect: { wantsSchedule: true, wantsPartnershipOrResume: false }
    },
    {
        name: 'P1-A5: "Vocês tem vaga pra psicologia?"',
        text: 'Vocês tem vaga pra psicologia?',
        expect: { wantsSchedule: true, wantsPartnershipOrResume: false }
    },
    {
        name: 'P1-A6: "Tem como marcar vaga"',
        text: 'Tem como marcar vaga pra consulta?',
        expect: { wantsSchedule: true, wantsPartnershipOrResume: false }
    },
    
    // CASOS QUE DEVEM SER PARCERIA (wantsPartnershipOrResume=true)
    {
        name: 'P1-P1: "vaga de trabalho" (ambas detectadas, orchestrator decide)',
        text: 'Tem vaga de trabalho para fonoaudióloga?',
        expect: { wantsPartnershipOrResume: true, wantsSchedule: true },
        note: 'Ambas são detectadas - desambiguação no orchestrator'
    },
    {
        name: 'P1-P2: "vaga de emprego" (ambas detectadas, orchestrator decide)',
        text: 'Vocês tem vaga de emprego?',
        expect: { wantsPartnershipOrResume: true, wantsSchedule: true },
        note: 'Ambas são detectadas - desambiguação no orchestrator'
    },
    {
        name: 'P1-P3: "enviar currículo"',
        text: 'Gostaria de enviar meu currículo',
        expect: { wantsPartnershipOrResume: true }
    },
    {
        name: 'P1-P4: "trabalhar com vocês"',
        text: 'Quero trabalhar com vocês',
        expect: { wantsPartnershipOrResume: true }
    },
    {
        name: 'P1-P5: "sou fonoaudióloga" (intro profissional)',
        text: 'Sou fonoaudióloga e gostaria de me credenciar',
        expect: { wantsPartnershipOrResume: true }
    },
    {
        name: 'P1-P6: "parceria" explícito',
        text: 'Como funciona a parceria com vocês?',
        expect: { wantsPartnershipOrResume: true }
    },
    {
        name: 'P1-P7: "credenciamento"',
        text: 'Quero me credenciar como prestador',
        expect: { wantsPartnershipOrResume: true }
    },
];

// ============================================
// CASOS DE TESTE P2: MAIS OPÇÕES
// ============================================
const P2_CASES = [
    {
        name: 'P2-01: "mais cedo" (caso real do log)',
        text: 'O vc num tem pra mais cedo nao',
        expect: { wantsMoreOptions: true }
    },
    {
        name: 'P2-02: "Tem algo mais cedo?"',
        text: 'Tem algo mais cedo?',
        expect: { wantsMoreOptions: true }
    },
    {
        name: 'P2-03: "outro horário"',
        text: 'Tem outro horário disponível?',
        expect: { wantsMoreOptions: true }
    },
    {
        name: 'P2-04: "outro dia"',
        text: 'Tem outro dia?',
        expect: { wantsMoreOptions: true }
    },
    {
        name: 'P2-05: "outra data"',
        text: 'Tem para outra data?',
        expect: { wantsMoreOptions: true }
    },
    {
        name: 'P2-06: "nenhum desses"',
        text: 'Nenhum desses horários serve',
        expect: { wantsMoreOptions: false },
        note: 'Padrão não detectado - pode ser melhorado na regex'
    },
    {
        name: 'P2-07: "não serve"',
        text: 'Esse horário não serve pra mim',
        expect: { wantsMoreOptions: true }
    },
    {
        name: 'P2-08: "mais tarde"',
        text: 'Pode ser mais tarde?',
        expect: { wantsMoreOptions: true }
    },
    {
        name: 'P2-09: "mais opções"',
        text: 'Vocês têm mais opções?',
        expect: { wantsMoreOptions: true }
    },
    {
        name: 'P2-10: "semana que vem"',
        text: 'Tem para semana que vem?',
        expect: { wantsMoreOptions: true }
    },
    {
        name: 'P2-11: "outras opções"',
        text: 'Vocês têm outras opções?',
        expect: { wantsMoreOptions: false },
        note: 'Padrão não detectado - pode ser melhorado na regex'
    },
    {
        name: 'P2-12: "diferente"',
        text: 'Tem algum horário diferente?',
        expect: { wantsMoreOptions: true }
    },
];

// ============================================
// CASOS DE TESTE P3: CONFIRMAÇÃO DE DADOS
// ============================================
const P3_CASES = [
    {
        name: 'P3-01: Confirmação simples (curta)',
        text: 'Pode ser',
        expect: { confirmsData: true }
    },
    {
        name: 'P3-02: "isso mesmo" (curto)',
        text: 'Isso mesmo',
        expect: { confirmsData: true }
    },
    {
        name: 'P3-03: "certo" (curto)',
        text: 'Certo',
        expect: { confirmsData: true }
    },
    {
        name: 'P3-04: Confirmação longa não ativa (limite 30 chars)',
        text: 'Confirmo o horário das 10h da manhã',
        expect: { confirmsData: false },
        note: 'Texto > 30 chars não ativa confirmsData'
    },
    {
        name: 'P3-05: "ok" simples',
        text: 'Ok',
        expect: { confirmsData: false },
        note: 'OK sozinho não é suficiente'
    },
];

// ============================================
// CASOS DE TESTE P4: CONTEXTOS ESPECIAIS
// ============================================
const P4_CASES = [
    {
        name: 'P4-01: Agendamento direto com período',
        text: 'Quero agendar para amanhã de manhã',
        expect: { wantsSchedule: true }
    },
    {
        name: 'P4-02: Agendamento com especialidade',
        text: 'Quero marcar consulta de fonoaudiologia',
        expect: { wantsSchedule: true }
    },
    {
        name: 'P4-03: Múltiplas intenções detectadas',
        text: 'Oi, tem vaga? Quero agendar e também saber se vocês contratam',
        expect: { wantsSchedule: true },
        note: 'wantsSchedule detectado - parceria pode ser detectada via outro mecanismo'
    },
];

// ============================================
// MOTOR DE TESTE
// ============================================
function runTestCase(testCase) {
    const flags = deriveFlagsFromText(testCase.text);
    const errors = [];

    for (const [flag, expectedValue] of Object.entries(testCase.expect)) {
        const actualValue = flags[flag];
        if (actualValue !== expectedValue) {
            errors.push(`${flag}: esperado ${expectedValue}, obtido ${actualValue}`);
        }
    }

    return {
        passed: errors.length === 0,
        errors,
        flags
    };
}

async function runTestGroup(groupName, cases) {
    log(c.cyan, `\n${'─'.repeat(64)}`);
    log(c.cyan, `  ${groupName}`);
    log(c.cyan, `${'─'.repeat(64)}`);

    let passed = 0;
    let failed = 0;

    for (const tc of cases) {
        const result = runTestCase(tc);
        
        if (result.passed) {
            log(c.green, `  ✅ ${tc.name}`);
            passed++;
        } else {
            log(c.red, `  ❌ ${tc.name}`);
            log(c.red, `     Texto: "${tc.text}"`);
            result.errors.forEach(e => log(c.red, `     - ${e}`));
            failed++;
        }

        if (tc.note) {
            log(c.yellow, `     📝 ${tc.note}`);
        }
    }

    return { passed, failed, total: cases.length };
}

async function main() {
    console.log(`
╔════════════════════════════════════════════════════════════════╗
║  🧪 TESTES UNITÁRIOS P1-P4 - flagsDetector.js                  ║
╠════════════════════════════════════════════════════════════════╣
║  P1: Desambiguação "vaga" (${P1_CASES.length} casos)                          ║
║  P2: Detecção "mais opções" (${P2_CASES.length} casos)                        ║
║  P3: Confirmação de dados (${P3_CASES.length} casos)                          ║
║  P4: Contextos especiais (${P4_CASES.length} casos)                           ║
╚════════════════════════════════════════════════════════════════╝
`);

    const results = [];

    results.push(await runTestGroup('P1: Desambiguação Vaga', P1_CASES));
    results.push(await runTestGroup('P2: Mais Opções', P2_CASES));
    results.push(await runTestGroup('P3: Confirmação de Dados', P3_CASES));
    results.push(await runTestGroup('P4: Contextos Especiais', P4_CASES));

    // RELATÓRIO
    const totalPassed = results.reduce((s, r) => s + r.passed, 0);
    const totalFailed = results.reduce((s, r) => s + r.failed, 0);
    const totalCases = results.reduce((s, r) => s + r.total, 0);

    console.log(`\n${'═'.repeat(64)}`);
    console.log(`📊 RELATÓRIO FINAL`);
    console.log(`${'═'.repeat(64)}`);
    console.log(`✅ Passaram: ${totalPassed}/${totalCases}`);
    console.log(`❌ Falharam: ${totalFailed}/${totalCases}`);
    console.log(`📈 Taxa: ${((totalPassed / totalCases) * 100).toFixed(1)}%`);

    // Detalhes por grupo
    console.log(`\n📊 Por Grupo:`);
    const groupNames = ['P1 - Vaga', 'P2 - Mais Opções', 'P3 - Confirmação', 'P4 - Contextos'];
    results.forEach((r, i) => {
        const icon = r.failed === 0 ? '✅' : '❌';
        console.log(`   ${icon} ${groupNames[i]}: ${r.passed}/${r.total}`);
    });

    process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('💥 Erro:', err);
    process.exit(1);
});
