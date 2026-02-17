#!/usr/bin/env node
/**
 * 🧪 TESTES ESPECÍFICOS PARA CORREÇÕES P1-P4
 * 
 * P1: Desambiguação "vaga" (parceria vs agendamento)
 * P2: Handler para "mais opções" de horários
 * P3: Validação de confirmação de dados do paciente
 * P4: Validação de slots reais antes de oferecer
 * 
 * Uso: node -r dotenv/config tests/amanda/p1-p4-fixes.test.js
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { getOptimizedAmandaResponse } from '../../orchestrators/AmandaOrchestrator.js';
import { deriveFlagsFromText } from '../../utils/flagsDetector.js';
import Leads from '../../models/Leads.js';
import Contacts from '../../models/Contacts.js';

const PHONE = '5562999990001';
const c = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m'
};

function log(color, msg) { console.log(`${color}${msg}${c.reset}`); }

// ============================================
// CENÁRIOS ESPECÍFICOS P1-P4
// ============================================
const FIX_SCENARIOS = [
    // ════════════════════════════════════════════
    // P1: DESAMBIGUAÇÃO "VAGA" (parceria vs agendamento)
    // ════════════════════════════════════════════
    {
        group: 'P1 - Desambiguação Vaga',
        name: 'P1-01: "tem vaga" em contexto de agendamento',
        rule: 'Deve detectar wantsSchedule=true e wantsPartnershipOrResume=false quando contexto é agendamento',
        critical: true, // Falha aqui = problema grave
        messages: [
            { 
                text: 'Quais os dias tem vaga?', 
                expectFlags: { wantsSchedule: true, wantsPartnershipOrResume: false },
                expectResponse: ['dia', 'horário', 'disponível', 'agendamento'],
                rejectResponse: ['parceria', 'currículo', 'vaga de trabalho', 'emprego', 'email']
            }
        ]
    },
    {
        group: 'P1 - Desambiguação Vaga',
        name: 'P1-02: "tem vaga para fonoaudiologia"',
        rule: 'Deve interpretar como agendamento de consulta',
        critical: true,
        messages: [
            { 
                text: 'Tem vaga para fonoaudiologia essa semana?',
                expectFlags: { wantsSchedule: true, wantsPartnershipOrResume: false },
                expectResponse: ['dia', 'horário', 'disponível'],
                rejectResponse: ['parceria', 'currículo', 'trabalho']
            }
        ]
    },
    {
        group: 'P1 - Desambiguação Vaga',
        name: 'P1-03: "tem vaga de trabalho" é parceria',
        rule: 'Deve interpretar como parceria quando menciona trabalho/emprego',
        messages: [
            { 
                text: 'Tem vaga de trabalho para fonoaudióloga?',
                expectFlags: { wantsPartnershipOrResume: true },
                expectResponse: ['currículo', 'parceria', 'email', 'profissional'],
                rejectResponse: ['agendar', 'consulta', 'horário']
            }
        ]
    },
    {
        group: 'P1 - Desambiguação Vaga',
        name: 'P1-04: "enviar currículo" é parceria',
        rule: 'Deve detectar parceria quando menciona currículo explicitamente',
        messages: [
            { 
                text: 'Gostaria de enviar meu currículo',
                expectFlags: { wantsPartnershipOrResume: true },
                expectResponse: ['currículo', 'parceria', 'email'],
                rejectResponse: ['agendar', 'consulta']
            }
        ]
    },
    {
        group: 'P1 - Desambiguação Vaga',
        name: 'P1-05: "trabalhar com vocês" é parceria',
        rule: 'Deve detectar parceria quando menciona trabalhar na clínica',
        messages: [
            { 
                text: 'Sou psicóloga e quero trabalhar com vocês',
                expectFlags: { wantsPartnershipOrResume: true },
                expectResponse: ['currículo', 'parceria', 'profissional'],
                rejectResponse: ['agendar', 'consulta']
            }
        ]
    },
    {
        group: 'P1 - Desambiguação Vaga',
        name: 'P1-06: Disambiguation quando ambos são detectados',
        rule: 'Quando ambos wantsSchedule e wantsPartnership são true, priorizar agendamento se contexto for scheduling',
        critical: true,
        messages: [
            { 
                text: 'Tem vaga pra essa semana?', 
                setupLead: (lead) => ({ ...lead, therapyArea: 'fonoaudiologia', lastTopic: 'agendamento' }),
                expectResponse: ['dia', 'horário', 'disponível', 'agendamento'],
                rejectResponse: ['parceria', 'currículo', 'trabalho']
            }
        ]
    },

    // ════════════════════════════════════════════
    // P2: HANDLER PARA "MAIS OPÇÕES"
    // ════════════════════════════════════════════
    {
        group: 'P2 - Mais Opções Handler',
        name: 'P2-01: "Tem algo mais cedo?"',
        rule: 'Deve detectar wantsMoreOptions e buscar slots alternativos',
        critical: true,
        messages: [
            { 
                text: 'Tem algo mais cedo?',
                expectFlags: { wantsMoreOptions: true },
                expectResponse: ['opção', 'horário', 'alternativa', 'dia'],
                rejectResponse: ['não entendi', 'pode repetir']
            }
        ]
    },
    {
        group: 'P2 - Mais Opções Handler',
        name: 'P2-02: "Nenhum desses horários serve"',
        rule: 'Deve detectar wantsMoreOptions quando rejeita opções',
        messages: [
            { 
                text: 'Nenhum desses horários serve pra mim',
                expectFlags: { wantsMoreOptions: true },
                expectResponse: ['outro', 'opção', 'alternativa'],
                rejectResponse: ['ok', 'entendido']
            }
        ]
    },
    {
        group: 'P2 - Mais Opções Handler',
        name: 'P2-03: "Tem outro dia?"',
        rule: 'Deve detectar wantsMoreOptions para mudança de dia',
        messages: [
            { 
                text: 'Tem outro dia disponível?',
                expectFlags: { wantsMoreOptions: true },
                expectResponse: ['dia', 'data', 'disponível'],
                rejectResponse: ['não entendi']
            }
        ]
    },
    {
        group: 'P2 - Mais Opções Handler',
        name: 'P2-04: "Pode ser mais tarde?"',
        rule: 'Deve detectar wantsMoreOptions para mudança de período',
        messages: [
            { 
                text: 'Pode ser mais tarde?',
                expectFlags: { wantsMoreOptions: true },
                expectResponse: ['tarde', 'noite', 'horário'],
                rejectResponse: ['não entendi']
            }
        ]
    },

    // ════════════════════════════════════════════
    // P3: CONFIRMAÇÃO DE DADOS DO PACIENTE
    // ════════════════════════════════════════════
    {
        group: 'P3 - Confirmação de Dados',
        name: 'P3-01: Coleta de nome e data de nascimento',
        rule: 'Deve coletar nome completo e data de nascimento antes de confirmar agendamento',
        critical: true,
        messages: [
            { 
                text: 'Oi, quero agendar para fonoaudiologia',
                expectResponse: ['nome', 'completo', 'paciente'],
            },
            { 
                text: 'João Silva',
                expectResponse: ['data', 'nascimento', 'nasc'],
            },
            { 
                text: '15/03/2018',
                expectResponse: ['confirmar', 'agendamento', 'ok'],
            }
        ]
    },
    {
        group: 'P3 - Confirmação de Dados',
        name: 'P3-02: Validação de data de nascimento inválida',
        rule: 'Deve pedir novamente se data for inválida',
        messages: [
            { 
                text: 'Oi, quero agendar para fonoaudiologia',
                setupLead: (lead) => ({ ...lead, pendingPatientInfoForScheduling: true, pendingPatientInfoStep: 'name' }),
            },
            { 
                text: 'João Silva',
                setupLead: (lead) => ({ ...lead, pendingPatientInfoForScheduling: true, pendingPatientInfoStep: 'birth' }),
            },
            { 
                text: ' data inválida ',
                expectResponse: ['data', 'nascimento', 'válida', 'dd/mm/aaaa', 'formato'],
                rejectResponse: ['confirmar', 'agendamento']
            }
        ]
    },

    // ════════════════════════════════════════════
    // P4: SLOTS REAIS (nunca inventar)
    // ════════════════════════════════════════════
    {
        group: 'P4 - Slots Reais',
        name: 'P4-01: Não deve inventar horários',
        rule: 'Deve sempre consultar available-slots antes de oferecer horários',
        critical: true,
        messages: [
            { 
                text: 'Quero agendar para amanhã de manhã',
                expectResponse: ['nome', 'paciente', 'especialidade'],
                rejectResponse: ['10:00', '14:00', '15:30'] // Não deve mencionar horários específicos sem consultar
            }
        ]
    },
    {
        group: 'P4 - Slots Reais',
        name: 'P4-02: Validação antes de confirmar',
        rule: 'Deve validar se slot ainda está disponível antes de confirmar agendamento',
        messages: [
            { 
                text: 'Confirmo o horário das 10h',
                setupLead: (lead) => ({ 
                    ...lead, 
                    pendingChosenSlot: { date: '2026-02-20', time: '10:00', doctorId: '123' }
                }),
                // Não podemos testar isso sem mock, mas documentamos a expectativa
                note: 'Deve chamar validateSlotStillAvailable antes de confirmar'
            }
        ]
    },

    // ════════════════════════════════════════════
    // CASOS REAIS DOS LOGS
    // ════════════════════════════════════════════
    {
        group: 'Casos Reais dos Logs',
        name: 'REAL-01: "Quais os dias tem vaga" (Log 2026-02-16)',
        rule: 'CASO REAL: Este erro foi detectado em produção - deve ser agendamento, não parceria',
        critical: true,
        messages: [
            { 
                text: 'Quais os dias tem vaga',
                expectFlags: { wantsSchedule: true, wantsPartnershipOrResume: false },
                expectResponse: ['dia', 'horário', 'disponível'],
                rejectResponse: ['parceria', 'currículo', 'email para', 'trabalho']
            }
        ]
    },
    {
        group: 'Casos Reais dos Logs',
        name: 'REAL-02: "O vc num tem pra mais cedo nao" (Log 2026-02-16)',
        rule: 'CASO REAL: Cliente pedindo horário mais cedo - deve detectar wantsMoreOptions',
        messages: [
            { 
                text: 'O vc num tem pra mais cedo nao',
                expectFlags: { wantsMoreOptions: true },
                expectResponse: ['opção', 'horário', 'mais cedo', 'alternativa'],
            }
        ]
    }
];

// ============================================
// MOTOR DE TESTE
// ============================================
async function setupLead(overrides = {}) {
    await Leads.deleteMany({ phone: PHONE });
    
    let contact = await Contacts.findOne({ phone: PHONE });
    if (!contact) {
        contact = await Contacts.create({ name: 'Teste P1-P4', phone: PHONE, source: 'test_p1p4' });
    }

    const leadData = {
        name: 'Teste P1-P4',
        phone: PHONE,
        contact: contact._id,
        source: 'test_p1p4',
        stage: 'novo',
        autoReplyEnabled: true,
        qualificationData: { extractedInfo: {} },
        ...overrides
    };

    const lead = await Leads.create(leadData);
    return lead;
}

async function testFlags(scenario, msg) {
    const flags = deriveFlagsFromText(msg.text);
    const errors = [];

    if (msg.expectFlags) {
        for (const [flag, expectedValue] of Object.entries(msg.expectFlags)) {
            const actualValue = flags[flag];
            if (actualValue !== expectedValue) {
                errors.push(`Flag ${flag}: esperado ${expectedValue}, obtido ${actualValue}`);
            }
        }
    }

    return { passed: errors.length === 0, errors, flags };
}

async function testResponse(scenario, msg, response) {
    const lower = (response || '').toLowerCase();
    const errors = [];
    const details = [];

    // Verifica expectativas
    if (msg.expectResponse) {
        for (const exp of msg.expectResponse) {
            if (!lower.includes(exp.toLowerCase())) {
                errors.push(`Faltou: "${exp}"`);
            } else {
                details.push(`✓ ${exp}`);
            }
        }
    }

    // Verifica rejeições
    if (msg.rejectResponse) {
        for (const rej of msg.rejectResponse) {
            if (lower.includes(rej.toLowerCase())) {
                errors.push(`Não deveria conter: "${rej}"`);
            }
        }
    }

    return { passed: errors.length === 0, errors, details };
}

async function runScenario(scenario) {
    const isCritical = scenario.critical ? ' 🔴' : '';
    log(c.cyan, `\n${'─'.repeat(64)}`);
    log(c.cyan, `  [${scenario.group}] ${scenario.name}${isCritical}`);
    log(c.gray, `  📋 ${scenario.rule}`);
    log(c.cyan, `${'─'.repeat(64)}`);

    let lead = await setupLead();
    let allPassed = true;
    let flagTests = [];
    let responseTests = [];

    for (let i = 0; i < scenario.messages.length; i++) {
        const msg = scenario.messages[i];
        log(c.gray, `\n  👤 [MSG ${i + 1}] "${msg.text}"`);

        // Setup lead se necessário
        if (msg.setupLead) {
            lead = await setupLead(msg.setupLead(lead));
        }

        // Teste de Flags
        if (msg.expectFlags) {
            const flagResult = await testFlags(scenario, msg);
            flagTests.push(flagResult);
            
            if (flagResult.passed) {
                log(c.green, `     ✅ Flags corretas: ${JSON.stringify(msg.expectFlags)}`);
            } else {
                log(c.red, `     ❌ Flags incorretas:`);
                flagResult.errors.forEach(e => log(c.red, `        - ${e}`));
                allPassed = false;
            }
        }

        // Teste de Resposta
        if (msg.expectResponse || msg.rejectResponse) {
            // Silencia logs
            const origLog = console.log;
            const origError = console.error;
            const origWarn = console.warn;
            console.log = () => {};
            console.error = () => {};
            console.warn = () => {};

            try {
                const freshLead = await Leads.findById(lead._id).lean();
                const response = await getOptimizedAmandaResponse({
                    content: msg.text,
                    userText: msg.text,
                    lead: freshLead,
                    context: { source: 'whatsapp-inbound' },
                    messageId: `test-p1p4-${Date.now()}`,
                });

                console.log = origLog;
                console.error = origError;
                console.warn = origWarn;

                const respText = response || '';
                const respResult = await testResponse(scenario, msg, respText);
                responseTests.push(respResult);

                if (respResult.passed) {
                    log(c.green, `     ✅ Resposta válida (${respText.length} chars)`);
                    respResult.details.forEach(d => log(c.gray, `        ${d}`));
                } else {
                    log(c.red, `     ❌ Resposta inválida:`);
                    respResult.errors.forEach(e => log(c.red, `        - ${e}`));
                    log(c.gray, `     📝 Resposta: "${respText.substring(0, 150)}..."`);
                    allPassed = false;
                }

            } catch (err) {
                console.log = origLog;
                console.error = origError;
                console.warn = origWarn;
                log(c.red, `     💥 ERRO: ${err.message}`);
                allPassed = false;
            }
        }

        if (msg.note) {
            log(c.yellow, `     📝 Nota: ${msg.note}`);
        }
    }

    return { passed: allPassed, scenario };
}

async function main() {
    console.log(`
╔════════════════════════════════════════════════════════════════╗
║  🧪 TESTES P1-P4 (CORREÇÕES CRÍTICAS)                         ║
╠════════════════════════════════════════════════════════════════╣
║  P1: Desambiguação "vaga" (parceria vs agendamento)           ║
║  P2: Handler "mais opções" de horários                         ║
║  P3: Confirmação de dados do paciente                          ║
║  P4: Slots reais (nunca inventar)                              ║
╚════════════════════════════════════════════════════════════════╝
`);

    await mongoose.connect(process.env.MONGO_URI);
    log(c.green, '✅ MongoDB conectado\n');

    const results = { passed: 0, failed: 0, critical: { passed: 0, failed: 0 } };
    const failures = [];

    for (const scenario of FIX_SCENARIOS) {
        const result = await runScenario(scenario);
        
        if (result.passed) {
            results.passed++;
            if (scenario.critical) results.critical.passed++;
        } else {
            results.failed++;
            if (scenario.critical) results.critical.failed++;
            failures.push({ name: scenario.name, group: scenario.group });
        }
    }

    // RELATÓRIO
    console.log(`\n${'═'.repeat(64)}`);
    console.log(`📊 RELATÓRIO DE TESTES P1-P4`);
    console.log(`${'═'.repeat(64)}`);
    console.log(`✅ Passaram:     ${results.passed}/${FIX_SCENARIOS.length}`);
    console.log(`❌ Falharam:     ${results.failed}/${FIX_SCENARIOS.length}`);
    console.log(`🔴 Críticos OK:  ${results.critical.passed}`);
    console.log(`🔴 Críticos NOK: ${results.critical.failed}`);
    console.log(`📈 Taxa:         ${((results.passed / FIX_SCENARIOS.length) * 100).toFixed(1)}%`);

    if (failures.length > 0) {
        console.log(`\n${'─'.repeat(64)}`);
        console.log(`❌ FALHAS (${failures.length}):`);
        failures.forEach(f => console.log(`   - [${f.group}] ${f.name}`));
    }

    await mongoose.disconnect();
    
    const exitCode = results.critical.failed > 0 ? 1 : (results.failed > 0 ? 1 : 0);
    process.exit(exitCode);
}

main().catch(err => {
    console.error('💥 Erro fatal:', err);
    process.exit(1);
});
